import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface CardCtrl {
  update(next: object | ((current: object) => object)): Promise<void>;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  /** Every card payload the streaming producer pushed via ctrl.update. */
  cardUpdates: object[];
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: { application: { get: ReturnType<typeof vi.fn> } };
    };
    im: {
      v1: {
        message: { get: ReturnType<typeof vi.fn> };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// >100 chars (SHORT_REPLY_MAX) so the compact renderer folds it into the
// detail panel and asks for a summary.
const LONG_REPLY =
  '经排查，支付回调超时的根因是网关侧重试风暴叠加下游数据库慢查询：' +
  'callback_log 表缺少 (merchant_id, created_at) 联合索引导致每次查询全表扫描，' +
  '高峰期单条查询超过 8 秒，网关 5 秒超时后重试进一步放大压力。' +
  '建议先加索引止血，再把回调处理改为异步落库。';

const INJECTED_SUMMARY = '根因是缺索引导致慢查询叠加网关重试风暴，先加索引止血。';

describe('compact card summary flow', () => {
  it('patches the compact card with the summarized reply after the ⏳ placeholder', async () => {
    const h = await createHarness();
    const summarize = vi.fn(async (_text: string) => INJECTED_SUMMARY);

    const bridge = await startChannel({
      cfg: h.profileConfig,
      agent: h.agent,
      sessions: h.sessions,
      workspaces: h.workspaces,
      controls: h.controls,
      summarize,
    });
    cleanups.push(() => bridge.disconnect());

    await h.channel.handlers.message?.(groupMessage('om_group_1', '帮我查下支付回调超时'));

    // Wait for the full producer flow: streaming updates → done card with the
    // ⏳ placeholder → summary patch.
    await waitFor(() =>
      h.channel.cardUpdates.some((card) => JSON.stringify(card).includes(INJECTED_SUMMARY)),
    );

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.[0]).toContain('callback_log');

    const rendered = h.channel.cardUpdates.map((card) => JSON.stringify(card));
    const placeholderIdx = rendered.findIndex((card) => card.includes('⏳ 正在生成总结'));
    const summaryIdx = rendered.findIndex((card) => card.includes(INJECTED_SUMMARY));
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(placeholderIdx);

    // The summary patch must be the terminal card state (nothing overwrote it).
    const last = rendered[rendered.length - 1] ?? '';
    expect(last).toContain(INJECTED_SUMMARY);
    expect(last).not.toContain('⏳ 正在生成总结');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('compact-card-summary-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
      allowedChats: ['oc_group'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: [
      [
        { type: 'text', delta: LONG_REPLY },
        { type: 'done', terminationReason: 'normal' },
      ],
    ],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardUpdates: object[] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    cardUpdates,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      // Group chat: with default prefs (cardStyle 'auto') resolveCardStyle
      // maps group → compact, which is exactly what this test exercises.
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    // Card-aware stream fake: run the producer to completion, recording
    // every ctrl.update payload so the test can inspect the card sequence.
    async stream(_chatId, input) {
      const card = (input as { card?: { producer?: (ctrl: CardCtrl) => Promise<void> } }).card;
      if (!card?.producer) throw new Error('expected card stream input');
      await card.producer({
        async update(next) {
          cardUpdates.push(typeof next === 'function' ? next({}) : next);
        },
      });
    },
    async addReaction() {
      return 'reaction_1';
    },
    async removeReaction() {},
  };
  return channel;
}

function groupMessage(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
