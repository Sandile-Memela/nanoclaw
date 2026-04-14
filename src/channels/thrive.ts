import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import * as amqp from 'amqplib';
import { Client, Databases, Functions, ID } from 'node-appwrite';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ── Omega's fixed identity in the Thrive system ───────────────────────────────

const OMEGA_ID = '6734b087001f134a06ab';
const OMEGA_TYPE = 'experiences';
const OMEGA_TEAM_ID = '672539760021d6dfc782';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThriveMessageType =
  | 'identity'
  | 'text'
  | 'time'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'story'
  | 'token'
  | 'survey'
  | 'contact'
  | 'document'
  | 'location'
  | 'widget'
  | 'status'
  | 'replyText'
  | 'replyTime'
  | 'replyLink'
  | 'replyImage'
  | 'replyVideo'
  | 'replyAudio'
  | 'replyStory'
  | 'replyToken'
  | 'replySurvey'
  | 'replyContact'
  | 'replyDocument'
  | 'replyLocation'
  | 'replyWidget'
  | 'replyStatus';

export type ThriveMessageStatus =
  | 'direct'
  | 'channel'
  | 'copy'
  | 'sent'
  | 'deliver'
  | 'read'
  | 'type';

export interface ThriveMessage {
  id: string;
  source_id: string;
  source_type: string;
  source_team_id: string;
  destination_id: string;
  destination_type: string;
  destination_team_id: string;
  creation_date: string;
  message_status: ThriveMessageStatus;
  message_type: ThriveMessageType;
  message: string | string[];
}

/** Appwrite function invocation payload for the RabbitMQ function. */
interface AppwriteFunctionPayload {
  operation: 'send' | 'channel' | 'receipt' | 'thread' | 'receive' | 'submit';
  chat?: string;
  sender?: string;
  message: string; // JSON string of ThriveMessage
  userId?: string;
  sessionId?: string;
  identifier: string;
  identifierType: string;
  identifierTeamId: string;
}

// ── JID helpers ───────────────────────────────────────────────────────────────

// JID format used inside NanoClaw: "id-type-teamId@thrive"
function toJid(id: string, type: string, teamId: string): string {
  return `${id}-${type}-${teamId}@thrive`;
}

function fromJid(jid: string): {
  id: string;
  type: string;
  teamId: string;
} {
  const userKey = jid.replace(/@thrive$/, '');
  const dashIdx = userKey.indexOf('-');
  const lastDash = userKey.lastIndexOf('-');
  return {
    id: userKey.slice(0, dashIdx),
    type: userKey.slice(dashIdx + 1, lastDash),
    teamId: userKey.slice(lastDash + 1),
  };
}

// Exchange name exactly as send.js produces it
function exchangeNameFor(
  id: string,
  type: string,
  teamId: string,
  sessionId: string,
): string {
  return `${id}-${type}-${teamId}@${sessionId}`;
}

// ── Session ID persistence ────────────────────────────────────────────────────

/**
 * Load Omega's session ID from .env, or generate + persist one on first run.
 * A stable session ID is required so devices can reliably publish to Omega's
 * exchange even after a restart.
 */
function resolveOmegaSessionId(envValue: string | undefined): string {
  if (envValue) return envValue;

  const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const envFile = path.join(process.cwd(), '.env');
  try {
    fs.appendFileSync(envFile, `\nTHRIVE_OMEGA_SESSION_ID=${newId}\n`);
    logger.info(
      { sessionId: newId },
      'Thrive: generated and persisted Omega session ID',
    );
  } catch (err) {
    logger.warn({ err }, 'Thrive: could not persist THRIVE_OMEGA_SESSION_ID');
  }
  return newId;
}

// ── ThriveChannel ─────────────────────────────────────────────────────────────

export interface ThriveChannelConfig {
  rabbitmqUrl: string;
  omegaSessionId: string;
  omegaUserId: string;
  appwriteEndpoint: string;
  appwriteProjectId: string;
  appwriteApiKey: string;
  appwriteFunctionId: string;
}

export class ThriveChannel implements Channel {
  name = 'thrive';

  // amqplib's connect() returns ChannelModel at runtime, not the Connection
  // interface — cast via unknown to satisfy the type checker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ch?: any;
  private connected = false;
  private reconnecting = false;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  private readonly cfg: ThriveChannelConfig;
  private readonly opts: ChannelOpts;

  constructor(opts: ChannelOpts, cfg: ThriveChannelConfig) {
    this.opts = opts;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    await this.connectInternal();
  }

  private async connectInternal(): Promise<void> {
    const url = new URL(this.cfg.rabbitmqUrl);
    url.searchParams.set('heartbeat', '60');
    this.conn = await amqp.connect(url.toString());
    this.ch = await this.conn.createChannel();

    this.conn.on('error', (err: unknown) => {
      logger.warn({ err }, 'Thrive: RabbitMQ connection error');
    });
    this.conn.on('close', () => {
      if (this.connected && !this.reconnecting) {
        this.connected = false;
        logger.warn('Thrive: connection closed — scheduling reconnect');
        this.scheduleReconnect();
      }
    });

    // Omega's inbound exchange — devices publish here to message Omega
    const omegaExchange = exchangeNameFor(
      OMEGA_ID,
      OMEGA_TYPE,
      OMEGA_TEAM_ID,
      this.cfg.omegaSessionId,
    );
    const queueName = this.cfg.omegaSessionId;

    // Mirror the topology from send.js: direct exchange, non-durable queue
    await this.ch.assertExchange(omegaExchange, 'direct', { durable: true });
    await this.ch.assertQueue(queueName, { durable: false });
    await this.ch.bindQueue(queueName, omegaExchange, '');

    this.ch.consume(queueName, (msg: amqp.ConsumeMessage | null) => {
      if (!msg) return;
      try {
        this.handleInbound(msg.content.toString());
        this.ch!.ack(msg);
      } catch (err) {
        logger.error({ err }, 'Thrive: error handling inbound message');
        this.ch!.nack(msg, false, false);
      }
    });

    this.connected = true;
    logger.info(
      { exchange: omegaExchange, queue: queueName },
      'Thrive channel connected',
    );
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    setTimeout(async () => {
      try {
        await this.connectInternal();
        this.reconnecting = false;
        logger.info('Thrive: reconnected');
      } catch (err) {
        logger.error({ err }, 'Thrive: reconnect failed — retrying in 5s');
        this.reconnecting = false;
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private handleInbound(raw: string): void {
    let msg: ThriveMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 120) }, 'Thrive: unparseable message');
      return;
    }

    logger.info(
      {
        id: msg.id,
        from: `${msg.source_id}-${msg.source_type}`,
        type: msg.message_type,
        status: msg.message_status,
        message: msg.message,
      },
      'Thrive: message received',
    );

    // Only route user text content to the agent; skip receipts/status updates
    const inboundTextTypes: ThriveMessageType[] = ['text', 'replyText'];
    if (!inboundTextTypes.includes(msg.message_type)) {
      logger.debug(
        { type: msg.message_type, status: msg.message_status },
        'Thrive: skipping non-text message',
      );
      return;
    }

    // Ignore receipt statuses (copy/sent/deliver/read/type) — those are echoes
    const ignoredStatuses: ThriveMessageStatus[] = [
      'copy',
      'sent',
      'deliver',
      'read',
      'type',
    ];
    if (ignoredStatuses.includes(msg.message_status)) {
      logger.debug(
        { status: msg.message_status },
        'Thrive: skipping receipt message',
      );
      return;
    }

    const jid = toJid(msg.source_id, msg.source_type, msg.source_team_id);
    const displayName = msg.source_id;

    this.opts.onChatMetadata(
      jid,
      msg.creation_date,
      displayName,
      'thrive',
      false,
    );

    // Auto-register new Thrive users so the message loop can route to them
    if (!this.opts.registeredGroups()[jid] && this.opts.registerGroup) {
      const safeId = msg.source_id.replace(/[^a-zA-Z0-9]/g, '');
      this.opts.registerGroup(jid, {
        name: displayName,
        folder: `thrive_${safeId}`,
        trigger: '@Omega',
        added_at: msg.creation_date,
        requiresTrigger: false,
      });
    }

    const newMessage: NewMessage = {
      id: msg.id,
      chat_jid: jid,
      sender: `${msg.source_id}-${msg.source_type}-${msg.source_team_id}`,
      sender_name: displayName,
      content: msg.message as string,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    };

    this.opts.onMessage(jid, newMessage);
  }

  /**
   * Send a typing indicator to a user. Mirrors the receipt pattern from the
   * iOS client: a "receipt" operation with message_status "type". Only fires
   * when Omega starts typing — stopping is implicit once the real message lands.
   *
   * jid format: "identifier-identifierType-identifierTeamId@thrive"
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) {
      const timer = this.typingTimers.get(jid);
      if (timer) {
        clearInterval(timer);
        this.typingTimers.delete(jid);
      }
      return;
    }

    const { id, type, teamId } = fromJid(jid);

    const sendTypingReceipt = async () => {
      const typingMsg: ThriveMessage = {
        id: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
        source_id: OMEGA_ID,
        source_type: OMEGA_TYPE,
        source_team_id: OMEGA_TEAM_ID,
        destination_id: id,
        destination_type: type,
        destination_team_id: teamId,
        creation_date: new Date().toISOString(),
        message_status: 'type',
        message_type: 'text',
        message: [],
      };

      await this.invokeFunction({
        operation: 'receipt',
        sender: 'Omega',
        message: JSON.stringify(typingMsg)
          .replaceAll("'", '~~')
          .replaceAll('"', "'"),
        userId: this.cfg.omegaUserId,
        sessionId: this.cfg.omegaSessionId,
        identifier: OMEGA_ID,
        identifierType: OMEGA_TYPE,
        identifierTeamId: OMEGA_TEAM_ID,
      });
    };

    // Fire immediately, then repeat every 3 seconds while agent is processing
    await sendTypingReceipt();
    const timer = setInterval(() => {
      sendTypingReceipt().catch((err) =>
        logger.warn({ err }, 'Thrive: typing receipt interval failed'),
      );
    }, 3000);
    this.typingTimers.set(jid, timer);
  }

  /**
   * Send Omega's response back to a user via the Appwrite RabbitMQ function.
   * The function resolves the destination's active device sessions, publishes
   * to each via RabbitMQ, and fires a push notification.
   *
   * jid format: "identifier-identifierType-identifierTeamId@thrive"
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    const { id, type, teamId } = fromJid(jid);

    const thriveMsg: ThriveMessage = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
      source_id: OMEGA_ID,
      source_type: OMEGA_TYPE,
      source_team_id: OMEGA_TEAM_ID,
      destination_id: id,
      destination_type: type,
      destination_team_id: teamId,
      creation_date: new Date().toISOString(),
      message_status: 'direct',
      message_type: 'text',
      message: text,
    };

    const payload: AppwriteFunctionPayload = {
      operation: 'receive',
      chat: 'Omega',
      sender: 'Omega',
      message: JSON.stringify(thriveMsg)
        .replaceAll("'", '~~')
        .replaceAll('"', "'"),
      userId: this.cfg.omegaUserId,
      sessionId: this.cfg.omegaSessionId,
      identifier: OMEGA_ID,
      identifierType: OMEGA_TYPE,
      identifierTeamId: OMEGA_TEAM_ID,
    };

    await this.invokeFunction(payload);
  }

  /**
   * Proactively send a message to a user (Guardian feature, scheduled tasks).
   * Same as sendMessage but exposed explicitly for clarity.
   */
  async sendProactive(
    destinationId: string,
    destinationType: string,
    destinationTeamId: string,
    text: string,
    operation: 'send' | 'channel' = 'send',
  ): Promise<void> {
    const jid = toJid(destinationId, destinationType, destinationTeamId);
    if (operation === 'channel') {
      const thriveMsg: ThriveMessage = {
        id: crypto.randomUUID().replace(/-/g, '').slice(0, 20),
        source_id: OMEGA_ID,
        source_type: OMEGA_TYPE,
        source_team_id: OMEGA_TEAM_ID,
        destination_id: destinationId,
        destination_type: destinationType,
        destination_team_id: destinationTeamId,
        creation_date: new Date().toISOString(),
        message_status: 'direct',
        message_type: 'text',
        message: text,
      };
      await this.invokeFunction({
        operation: 'receive',
        chat: 'Omega',
        sender: 'Omega',
        message: JSON.stringify(thriveMsg)
          .replaceAll("'", '~~')
          .replaceAll('"', "'"),
        userId: this.cfg.omegaUserId,
        sessionId: this.cfg.omegaSessionId,
        identifier: OMEGA_ID,
        identifierType: OMEGA_TYPE,
        identifierTeamId: OMEGA_TEAM_ID,
      });
    } else {
      await this.sendMessage(jid, text);
    }
  }

  private async invokeFunction(
    payload: AppwriteFunctionPayload,
  ): Promise<void> {
    try {
      const client = new Client()
        .setEndpoint(this.cfg.appwriteEndpoint)
        .setProject(this.cfg.appwriteProjectId)
        .setKey(this.cfg.appwriteApiKey);

      const functions = new Functions(client);
      await functions.createExecution(
        this.cfg.appwriteFunctionId,
        JSON.stringify(payload),
        false, // synchronous
      );
      logger.debug(
        { operation: payload.operation, destination: payload.identifier },
        'Thrive: function invoked',
      );
    } catch (err) {
      logger.error(
        { err, operation: payload.operation },
        'Thrive: Appwrite function invocation failed',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@thrive');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.ch?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.conn?.close();
    } catch {
      /* ignore */
    }
  }
}

// ── Self-registration ─────────────────────────────────────────────────────────

const env = readEnvFile([
  'RABBITMQ_URL',
  'THRIVE_OMEGA_SESSION_ID',
  'THRIVE_OMEGA_USER_ID',
  'THRIVE_APPWRITE_ENDPOINT',
  'THRIVE_APPWRITE_PROJECT_ID',
  'THRIVE_APPWRITE_API_KEY',
  'THRIVE_APPWRITE_FUNCTION_ID',
]);

const rabbitmqUrl = process.env.RABBITMQ_URL || env.RABBITMQ_URL;
const appwriteEndpoint =
  process.env.THRIVE_APPWRITE_ENDPOINT || env.THRIVE_APPWRITE_ENDPOINT;
const appwriteProjectId =
  process.env.THRIVE_APPWRITE_PROJECT_ID || env.THRIVE_APPWRITE_PROJECT_ID;
const appwriteApiKey =
  process.env.THRIVE_APPWRITE_API_KEY || env.THRIVE_APPWRITE_API_KEY;
const appwriteFunctionId =
  process.env.THRIVE_APPWRITE_FUNCTION_ID || env.THRIVE_APPWRITE_FUNCTION_ID;
const omegaUserId =
  process.env.THRIVE_OMEGA_USER_ID || env.THRIVE_OMEGA_USER_ID || '';

if (
  rabbitmqUrl &&
  appwriteEndpoint &&
  appwriteProjectId &&
  appwriteApiKey &&
  appwriteFunctionId
) {
  const rawSessionId =
    process.env.THRIVE_OMEGA_SESSION_ID || env.THRIVE_OMEGA_SESSION_ID;
  const omegaSessionId = resolveOmegaSessionId(rawSessionId);

  registerChannel('thrive', (opts) => {
    return new ThriveChannel(opts, {
      rabbitmqUrl,
      omegaSessionId,
      omegaUserId,
      appwriteEndpoint,
      appwriteProjectId,
      appwriteApiKey,
      appwriteFunctionId,
    });
  });

  logger.debug('Thrive channel registered');
} else {
  logger.debug(
    'Thrive channel not registered: one or more required env vars missing ' +
      '(RABBITMQ_URL, THRIVE_APPWRITE_ENDPOINT, THRIVE_APPWRITE_PROJECT_ID, ' +
      'THRIVE_APPWRITE_API_KEY, THRIVE_APPWRITE_FUNCTION_ID)',
  );
}
