import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter & { closeSession: ReturnType<typeof vi.fn> };
  controls: Controls;
  cleanup(): Promise<void>;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('closeSession integration — /new, /reset, /cd', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('calls closeSession with the previous sessionId when /new is run with an existing session', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'session-abc', h.tmp.workspace);

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.agent.closeSession).toHaveBeenCalledTimes(1);
    expect(h.agent.closeSession).toHaveBeenCalledWith('session-abc');
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
  });

  it('does NOT call closeSession when /new is run without any stored session', async () => {
    const h = await createHarness();
    // No sessions.set — no previous session exists

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.agent.closeSession).not.toHaveBeenCalled();
  });

  it('calls closeSession with the previous sessionId when /cd is run with a valid absolute path', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'session-cd-old', h.tmp.workspace);

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);

    expect(h.agent.closeSession).toHaveBeenCalledTimes(1);
    expect(h.agent.closeSession).toHaveBeenCalledWith('session-cd-old');
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('close-session-test-');

  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();

  // Build an agent with a spy closeSession
  const agent = new FakeAgentAdapter() as FakeAgentAdapter & {
    closeSession: ReturnType<typeof vi.fn>;
  };
  agent.closeSession = vi.fn(async (_sessionId: string) => {});

  const profileConfig = appConfig(tmp.workspace);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: `${tmp.profile}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  const cleanup = async (): Promise<void> => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  };
  cleanups.push(cleanup);

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, cleanup, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
