import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Events, Query } from "teamspeak.js";
import type { Client } from "teamspeak.js/dist/structures/client";

type QueryProtocol = "ssh" | "tcp";

type Config = {
  tsHost: string;
  tsPort?: number;
  tsServerId: number;
  tsQueryProtocol: QueryProtocol;
  tsQueryUsername: string;
  tsQueryPassword: string;
  telegramBotToken: string;
  telegramChatId: string;
};

const RECONNECT_DELAY_MS = 5_000;
const TELEGRAM_RETRY_DELAY_MS = 2_000;
const TELEGRAM_RETRY_ATTEMPTS = 3;
const CLIENT_SYNC_INTERVAL_MS = 10_000;
const BASE_DIR = "pkg" in process ? dirname(process.execPath) : process.cwd();
const CONFIG_PATH = resolve(BASE_DIR, "data", "config.json");

type ClientSnapshot = {
  id: number | null;
  uniqueId: string | null;
  nickname: string | null;
  channelId: number | null;
  channelLabel: string;
  type: number | null;
};

function isPackagedExe(): boolean {
  return "pkg" in process;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function parseNumber(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseProtocol(value: string): QueryProtocol {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "ssh" && normalized !== "tcp") {
    throw new Error('Protocol must be either "ssh" or "tcp".');
  }
  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function loadEnvConfig(): Config | undefined {
  const tsHost = process.env.TS_HOST?.trim();
  if (!tsHost) {
    return undefined;
  }

  return {
    tsHost,
    tsPort: process.env.TS_PORT?.trim() ? parseNumber(requireEnv("TS_PORT"), "TS_PORT") : undefined,
    tsServerId: process.env.TS_SERVER_ID?.trim() ? parseNumber(requireEnv("TS_SERVER_ID"), "TS_SERVER_ID") : 1,
    tsQueryProtocol: process.env.TS_QUERY_PROTOCOL?.trim() ? parseProtocol(requireEnv("TS_QUERY_PROTOCOL")) : "ssh",
    tsQueryUsername: requireEnv("TS_QUERY_USERNAME"),
    tsQueryPassword: requireEnv("TS_QUERY_PASSWORD"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID")
  };
}

function loadSavedConfig(): Config | undefined {
  if (!existsSync(CONFIG_PATH)) {
    return undefined;
  }

  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<Config>;

  if (
    !parsed.tsHost ||
    !parsed.tsServerId ||
    !parsed.tsQueryProtocol ||
    !parsed.tsQueryUsername ||
    !parsed.tsQueryPassword ||
    !parsed.telegramBotToken ||
    !parsed.telegramChatId
  ) {
    throw new Error(`Saved config is incomplete: ${CONFIG_PATH}`);
  }

  return {
    tsHost: parsed.tsHost,
    tsPort: parsed.tsPort,
    tsServerId: parsed.tsServerId,
    tsQueryProtocol: parseProtocol(parsed.tsQueryProtocol),
    tsQueryUsername: parsed.tsQueryUsername,
    tsQueryPassword: parsed.tsQueryPassword,
    telegramBotToken: parsed.telegramBotToken,
    telegramChatId: parsed.telegramChatId
  };
}

function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 3)}${"*".repeat(Math.max(3, value.length - 6))}${value.slice(-3)}`;
}

async function ask(question: string, defaultValue?: string, secret = false): Promise<string> {
  const rl = createInterface({ input, output });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const prompt = `${question}${suffix}${secret ? " (input visible)" : ""}: `;

  try {
    const answer = await rl.question(prompt);
    return answer.trim() || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function pauseBeforeExit(): Promise<void> {
  if (!isPackagedExe()) {
    return;
  }
  await ask("Press Enter to close");
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const defaultValue = defaultYes ? "Y/n" : "y/N";
  const answer = (await ask(question, defaultValue)).toLowerCase();
  if (answer === "y" || answer === "yes") {
    return true;
  }
  if (answer === "n" || answer === "no") {
    return false;
  }
  return defaultYes;
}

async function collectConfig(saved?: Config): Promise<Config> {
  output.write("\nTeamSpeak 6 Telegram Bot Setup\n");
  output.write("--------------------------------\n");

  if (saved) {
    output.write(`Saved server: ${saved.tsHost}:${saved.tsPort ?? "(default)"} / server ID ${saved.tsServerId}\n`);
    output.write(`Saved Telegram bot: ${maskSecret(saved.telegramBotToken)} -> chat ${saved.telegramChatId}\n`);
    output.write("\n");
  }

  const tsHost = await ask("TeamSpeak host", saved?.tsHost);
  const tsPortRaw = await ask("TeamSpeak query port", saved?.tsPort ? String(saved.tsPort) : "");
  const tsServerIdRaw = await ask("Virtual server ID", saved ? String(saved.tsServerId) : "1");
  const protocolRaw = await ask("Query protocol (ssh/tcp)", saved?.tsQueryProtocol ?? "ssh");
  const tsQueryUsername = await ask("ServerQuery username", saved?.tsQueryUsername);
  const tsQueryPassword = await ask("ServerQuery password", saved?.tsQueryPassword, true);
  const telegramBotToken = await ask("Telegram bot token", saved?.telegramBotToken, true);
  const telegramChatId = await ask("Telegram chat ID", saved?.telegramChatId);

  return {
    tsHost,
    tsPort: tsPortRaw ? parseNumber(tsPortRaw, "TeamSpeak query port") : undefined,
    tsServerId: parseNumber(tsServerIdRaw, "Virtual server ID"),
    tsQueryProtocol: parseProtocol(protocolRaw),
    tsQueryUsername,
    tsQueryPassword,
    telegramBotToken,
    telegramChatId
  };
}

function createQuery(config: Config): Query {
  return new Query({
    host: config.tsHost,
    port: config.tsPort,
    protocol: config.tsQueryProtocol,
    ssh: config.tsQueryProtocol === "ssh"
      ? {
          username: config.tsQueryUsername,
          password: config.tsQueryPassword
        }
      : undefined
  });
}

async function sendTelegramMessage(config: Config, text: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TELEGRAM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text
        })
      });

      if (!response.ok) {
        const details = await response.text();
        throw new Error(`Telegram API error ${response.status}: ${details}`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt < TELEGRAM_RETRY_ATTEMPTS) {
        console.warn(`Telegram send attempt ${attempt} failed. Retrying...`);
        await sleep(TELEGRAM_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown Telegram delivery error.");
}

async function bootstrap(query: Query, config: Config): Promise<void> {
  if (config.tsQueryProtocol === "tcp") {
    await query.login(config.tsQueryUsername, config.tsQueryPassword);
  }

  await query.virtualServers.use(config.tsServerId);
  await query.notifications.subscribeAll();

  console.log(`Ready: listening on ${config.tsHost}, virtual server ${config.tsServerId}.`);
}

async function resolveChannelLabel(client: Client): Promise<string> {
  const channel = client.channel;
  if (!channel) {
    return `channel #${client.channelId ?? "unknown"}`;
  }

  try {
    const fullChannel = await channel.fetch();
    return `${fullChannel.name} (#${fullChannel.id})`;
  } catch {
    return `channel #${client.channelId ?? "unknown"}`;
  }
}

function buildClientSnapshotFromClient(client: Client): ClientSnapshot {
  return {
    id: client.id ?? null,
    uniqueId: client.uniqueId ?? null,
    nickname: client.nickname ?? null,
    channelId: client.channelId ?? null,
    channelLabel: client.channel?.name
      ? `${client.channel.name} (#${client.channel.id})`
      : `channel #${client.channelId ?? "unknown"}`,
    type: client.type ?? null
  };
}

function getClientKey(client: Pick<ClientSnapshot, "uniqueId" | "id">): string | undefined {
  if (client.uniqueId) {
    return `uid:${client.uniqueId}`;
  }
  if (client.id !== null) {
    return `clid:${client.id}`;
  }
  return undefined;
}

function isRegularClient(client: Pick<ClientSnapshot, "type">): boolean {
  return client.type !== 1;
}

function formatJoinMessage(snapshot: ClientSnapshot): string {
  return [
    "@LE_EX",
    "New TeamSpeak connection",
    `Nickname: ${snapshot.nickname ?? "unknown"}`,
    `Client ID: ${snapshot.id ?? "unknown"}`,
    `Unique ID: ${snapshot.uniqueId ?? "unknown"}`,
    `Channel: ${snapshot.channelLabel}`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

function formatLeaveMessage(snapshot: ClientSnapshot): string {
  return [
    "@LE_EX",
    "TeamSpeak client disconnected",
    `Nickname: ${snapshot.nickname ?? "unknown"}`,
    `Client ID: ${snapshot.id ?? "unknown"}`,
    `Unique ID: ${snapshot.uniqueId ?? "unknown"}`,
    `Last channel: ${snapshot.channelLabel}`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

async function sendJoinNotification(config: Config, snapshot: ClientSnapshot, source: string): Promise<void> {
  console.log(`[join:${source}] ${snapshot.nickname ?? "unknown"} | ${snapshot.uniqueId ?? snapshot.id ?? "unknown"} | ${snapshot.channelLabel}`);
  await sendTelegramMessage(config, formatJoinMessage(snapshot));
  console.log(`Telegram join notification sent for ${snapshot.nickname ?? "unknown client"}.`);
}

async function sendLeaveNotification(config: Config, snapshot: ClientSnapshot, source: string): Promise<void> {
  console.log(`[leave:${source}] ${snapshot.nickname ?? "unknown"} | ${snapshot.uniqueId ?? snapshot.id ?? "unknown"} | ${snapshot.channelLabel}`);
  await sendTelegramMessage(config, formatLeaveMessage(snapshot));
  console.log(`Telegram leave notification sent for ${snapshot.nickname ?? "unknown client"}.`);
}

async function notifyClientJoin(config: Config, client: Client): Promise<void> {
  const snapshot = buildClientSnapshotFromClient(client);
  if (!isRegularClient(snapshot)) {
    return;
  }

  snapshot.channelLabel = await resolveChannelLabel(client);
  await sendJoinNotification(config, snapshot, "event");
}

async function notifyClientLeave(config: Config, client: Client): Promise<void> {
  const snapshot = buildClientSnapshotFromClient(client);
  if (!isRegularClient(snapshot)) {
    return;
  }

  snapshot.channelLabel = await resolveChannelLabel(client);
  await sendLeaveNotification(config, snapshot, "event");
}

function startBot(config: Config): void {
  let reconnectTimer: NodeJS.Timeout | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let activeQuery: Query | undefined;
  const knownClients = new Map<string, ClientSnapshot>();

  const syncClients = async (query: Query, mode: "initial" | "poll"): Promise<void> => {
    const fetchedClients = await query.clients.fetch();
    const currentClients = new Map<string, ClientSnapshot>();

    for (const client of fetchedClients.values()) {
      const snapshot = buildClientSnapshotFromClient(client);
      if (!isRegularClient(snapshot)) {
        continue;
      }

      snapshot.channelLabel = await resolveChannelLabel(client);
      const key = getClientKey(snapshot);
      if (!key) {
        continue;
      }

      currentClients.set(key, snapshot);
    }

    if (mode === "initial") {
      knownClients.clear();
      for (const [key, snapshot] of currentClients) {
        knownClients.set(key, snapshot);
      }
      console.log(`Initial client snapshot loaded: ${currentClients.size} clients.`);
      return;
    }

    for (const [key, snapshot] of currentClients) {
      if (!knownClients.has(key)) {
        try {
          await sendJoinNotification(config, snapshot, "poll");
        } catch (error) {
          console.error("Failed to send Telegram join notification from poll.", error);
        }
      }
    }

    for (const [key, snapshot] of knownClients) {
      if (!currentClients.has(key)) {
        try {
          await sendLeaveNotification(config, snapshot, "poll");
        } catch (error) {
          console.error("Failed to send Telegram leave notification from poll.", error);
        }
      }
    }

    knownClients.clear();
    for (const [key, snapshot] of currentClients) {
      knownClients.set(key, snapshot);
    }
  };

  const connect = (): void => {
    const query = createQuery(config);
    activeQuery = query;
    let initialized = false;

    query.on(Events.Ready, async () => {
      try {
        await bootstrap(query, config);
        await syncClients(query, "initial");
        syncTimer = setInterval(() => {
          void syncClients(query, "poll").catch((error) => {
            console.error("Client sync failed.", error);
          });
        }, CLIENT_SYNC_INTERVAL_MS);
        initialized = true;
      } catch (error) {
        console.error("Failed to initialize TeamSpeak query session.", error);
        await query.destroy();
      }
    });

    query.on(Events.ClientEnterView, async (client) => {
      if (!initialized) {
        return;
      }

      try {
        const snapshot = buildClientSnapshotFromClient(client);
        const key = getClientKey(snapshot);
        if (key) {
          knownClients.set(key, snapshot);
        }
        await notifyClientJoin(config, client);
      } catch (error) {
        console.error("Failed to send Telegram notification.", error);
      }
    });

    query.on(Events.ClientLeaveView, async (client) => {
      if (!initialized) {
        return;
      }

      try {
        const snapshot = buildClientSnapshotFromClient(client);
        const key = getClientKey(snapshot);
        if (key) {
          knownClients.delete(key);
        }
        await notifyClientLeave(config, client);
      } catch (error) {
        console.error("Failed to send Telegram leave notification.", error);
      }
    });

    query.on(Events.Error, (error) => {
      console.error("TeamSpeak query error.", error);
    });

    query.on(Events.Close, () => {
      console.warn("TeamSpeak connection closed.");
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = undefined;
      }
      knownClients.clear();
      if (shuttingDown) {
        return;
      }
      reconnectTimer = setTimeout(() => {
        console.log("Reconnecting to TeamSpeak...");
        connect();
      }, RECONNECT_DELAY_MS);
    });

    void query.connect().catch((error) => {
      console.error("Failed to connect to TeamSpeak.", error);
      reconnectTimer = setTimeout(() => {
        console.log("Retrying TeamSpeak connection...");
        connect();
      }, RECONNECT_DELAY_MS);
    });
  };

  const stop = (): void => {
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (syncTimer) {
      clearInterval(syncTimer);
    }
    if (activeQuery) {
      activeQuery.destroy();
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  connect();
}

async function selectConfig(): Promise<Config> {
  const envConfig = loadEnvConfig();
  if (envConfig) {
    console.log("Using configuration from environment variables.");
    return envConfig;
  }

  const savedConfig = loadSavedConfig();
  if (savedConfig) {
    const reuseSaved = await confirm("Use saved configuration?", true);
    if (reuseSaved) {
      return savedConfig;
    }
  }

  const config = await collectConfig(savedConfig);
  saveConfig(config);
  console.log(`Configuration saved to ${CONFIG_PATH}.`);
  return config;
}

async function main(): Promise<void> {
  const config = await selectConfig();
  startBot(config);
}

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception.", error);
  await pauseBeforeExit();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection.", reason);
  await pauseBeforeExit();
  process.exit(1);
});

void main().catch(async (error) => {
  console.error("Fatal error.", error);
  await pauseBeforeExit();
  process.exitCode = 1;
});
