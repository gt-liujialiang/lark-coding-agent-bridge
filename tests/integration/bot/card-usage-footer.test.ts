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
  channel: undefined as FakeChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface FakeChannel {
  botIdentity: { openId: string; name: string };
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  cardUpdates: unknown[];
  rawClient: unknown;
  on(handlers: FakeChannel['handlers']): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(): Promise<'group'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(card: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, card: unknown, sequence?: number): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  addReaction(): Promise<string>;
  removeReaction(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

describe('card usage footer wiring', () => {
  it('renders the token footer on the final card after a usage event', async () => {
    const tmp = await createTmpProfile('card-usage-footer-');
    const workspace = await realpath(tmp.workspace);
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_user'] },
    });
    const profileConfig = {
      ...base,
      workspaces: { ...base.workspaces, default: workspace },
      preferences: { ...base.preferences, messageReply: 'card' as const, showToolCalls: false },
    };

    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
    const agent = new FakeAgentAdapter({
      id: 'claude',
      displayName: 'Claude',
      events: [
        [
          { type: 'text', delta: '最终答案' },
          { type: 'usage', inputTokens: 1234, outputTokens: 856, costUsd: 0.0312 },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
    });

    const channel = createChannel();
    sdkMock.channel = channel;
    const controls = makeControls(profileConfig);
    cleanups.push(async () => {
      await Promise.all([sessions.flush(), workspaces.flush()]);
      await tmp.cleanup();
    });

    const bridge = await startChannel({
      cfg: profileConfig,
      agent,
      sessions,
      workspaces,
      controls,
    });
    cleanups.push(() => bridge.disconnect());

    await channel.handlers.message?.(makeMessage());
    await waitFor(() => channel.cardUpdates.length > 0 && agent.runOptions.length === 1);
    // Let the terminal flushes settle.
    await waitFor(() => {
      const last = JSON.stringify(channel.cardUpdates[channel.cardUpdates.length - 1]);
      return last.includes('最终答案') && !last.includes('streaming_mode":true');
    });

    const finalCard = JSON.stringify(channel.cardUpdates[channel.cardUpdates.length - 1]);
    expect(finalCard).toContain('最终答案');
    expect(finalCard).toContain('📊');
    expect(finalCard).toContain('输入 1.2k');
    expect(finalCard).toContain('输出 856');
  });
});

function createChannel(): FakeChannel {
  const handlers: FakeChannel['handlers'] = {};
  const cardUpdates: unknown[] = [];
  const channel: FakeChannel = {
    handlers,
    cardUpdates,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } } },
      im: { v1: { message: { get: vi.fn(async () => ({ data: { items: [] } })) }, messageReaction: { create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })), delete: vi.fn(async () => ({})) } } },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    // Managed entity-card path: createCard → send(by cardId) → updateCardById.
    async createCard(card: unknown) {
      cardUpdates.push(card);
      return { cardId: 'card_fake_1' };
    },
    async updateCardById(_cardId: string, card: unknown) {
      cardUpdates.push(card);
    },
    async send(_chatId, content) {
      // Card sends reference a cardId; content updates come via updateCardById.
      if (!(content as { cardId?: unknown })?.cardId) cardUpdates.push(content);
      return { messageId: 'om_reply_1' };
    },
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
  };
  return channel;
}

function makeControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'claude',
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

function makeMessage(): NormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: '你好',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
