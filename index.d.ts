// Type definitions for ac-playtest.
import type { Browser, BrowserContext, CDPSession, Frame, Locator, Page } from 'playwright-core';

export interface Size { width: number; height: number }

export interface LaunchOptions {
  /** Build folder with screen.html and controller.html. */
  build: string;
  /** Phones to connect before launch() resolves. Default 0. */
  phones?: number;
  /** Default true. */
  headless?: boolean;
  /** Server port; default 0 (any free port). */
  port?: number;
  /** Version the stand-in API reports (default: the version in the game's script tag). */
  apiVersion?: string;
  /** 'official' loads the real library from airconsole.com (needs internet). Default 'builtin'. */
  api?: 'builtin' | 'official';
  /** Reuse a browser (from launchBrowser() or playwright-core); sim.close() then leaves it open. */
  browser?: Browser;
  /** Browser channel, e.g. 'chrome'. Default: Playwright's Chromium if installed, else Google Chrome. */
  channel?: string;
  executablePath?: string;
  browserArgs?: string[];
  /** Mute audio. Default true. */
  mute?: boolean;
  /** Ms to wait for the screen's `new AirConsole()`. Default 60000. */
  readyTimeout?: number;
  /** Default timeout of the waitFor* helpers in ms. Default 10000. */
  timeout?: number;
  /** Browser viewport; default fits the screen and two phones. */
  viewport?: Size;
  /** Server log lines (404s, API version notes). */
  log?: (line: string) => void;

  // ---- simulated platform
  /** Join code passed to onReady. Default '1234 5678'. */
  code?: string;
  /** Screen frame size in CSS px. Default 1280x720. */
  screenSize?: Size;
  /** Phone frame size in CSS px, portrait; landscape swaps it. Default 360x640. */
  phoneSize?: Size;
  /** Display scale of the device frames in the sim page. Default 1. */
  scale?: number;
  /** How long an ad "plays" (ms) before onAdComplete(true). Default 2500. */
  adDuration?: number;
  /** false: showAd() finds no ad (only onAdComplete(false)). Default true. */
  adFill?: boolean;
  /** Extra delay (ms) for every platform -> device message. Default 0. */
  latency?: number;
  /** Default device language. Default 'en'. */
  language?: string;
  /** server_time_offset reported to devices that use synchronize_time. Default 0. */
  serverTimeOffset?: number;
  /** Translations by language, sent to devices constructed with {translation: true}: {en: {id: 'text'}}. */
  translations?: Record<string, Record<string, string>>;
  /** Sent to the screen's onReady (getGameConfiguration()). Default: not sent. */
  gameConfiguration?: Record<string, unknown>;
  /** Sent to the screen's onReady and onSetSafeArea. Default: not sent. */
  gameSafeArea?: { top: number; left: number; bottom: number; right: number };
  /** Initial persistent data: {uid: {key: value}}. */
  persistentData?: Record<string, Record<string, unknown>>;
}

export interface PhoneProfile {
  nickname?: string;
  uid?: string;
  premium?: boolean;
  language?: string;
  /** Ms to wait for the phone to connect. Default 30000. */
  timeout?: number;
}

/** A recorded platform event. `seq` increases by one per event. */
export interface SimEvent {
  seq: number;
  time: number;
  type: 'ready' | 'join' | 'connect' | 'disconnect' | 'message' | 'custom' | 'players' | 'ad' | 'pause' | 'resume'
    | 'premium' | 'profile' | 'navigate' | 'vibrate' | 'orientation' | 'immersive' | 'highScoreStored' | 'highScores'
    | 'persistentStore' | 'persistentRequest' | 'jserror' | 'platformEvent' | 'set' | string;
  device?: number;
  [field: string]: unknown;
}

/** A message as it left the sender, after the JSON round-trip. `to` is 'all' for broadcasts. */
export interface SimMessage extends SimEvent {
  type: 'message';
  from: number;
  to: number | 'all';
  data: any;
}

/** {from, to, type}: `type` is compared with `data.type`; `to: n` includes broadcasts that reached n. */
export type MessageFilter = { from?: number; to?: number | 'all'; type?: unknown } | ((message: SimMessage) => boolean);
export type EventFilter = Partial<SimEvent> | ((event: SimEvent) => boolean);
export interface WaitOptions {
  timeout?: number;
  /** Only consider events recorded after this mark (see sim.mark()). */
  since?: number;
}

export interface AdRecord { id: number; requestedAt: number; shown?: boolean; completedAt?: number; ignored?: boolean }

export interface ConsoleEntry {
  /** console message type ('error', 'warning', 'log', ...), 'pageerror' or 'jserror' (reported by the API). */
  type: string;
  text: string;
  url?: string;
  /** Device id, for 'jserror' entries. */
  device?: number;
  stack?: string;
  time: number;
}

/** A point in the device's CSS pixels. */
export interface Point { x: number; y: number }
/** Visible text, a selector (`#id`, `.class`, `[attr]`, `css=`, `text=`, `role=`, `xpath=` ...), or a Locator. */
export type Target = string | Locator;

export interface TapOptions { pointerType?: 'touch' | 'mouse'; timeout?: number }
export interface DragOptions {
  /** Intermediate moves. Default 10. */
  steps?: number;
  /** Ms spread over the moves. Default 250. */
  duration?: number;
  /** Ms to wait at the end before releasing. Default 0. */
  hold?: number;
  pointerType?: 'touch' | 'mouse';
}

export class Device {
  readonly sim: Sim;
  readonly id: number;
  /** The device's frame (replaced when a phone reconnects). */
  readonly frame: Frame;
  readonly page: Page;
  readonly isScreen: boolean;
  /** Locator of the device's <iframe> element in the sim page. */
  readonly frameElement: Locator;
  locator(target: Target): Locator;
  tap(target: Target | Point, options?: TapOptions): Promise<void>;
  drag(from: Target | Point, to: Target | Point, options?: DragOptions): Promise<void>;
  toPage(target: Target | Point): Promise<Point>;
  evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  /** Sends as if this device called airconsole.message(to, data). Default `to`: screen (phones), all (screen). */
  send(data: unknown, to?: number): Promise<void>;
  /** Messages delivered to this device. */
  messages(filter?: MessageFilter): SimMessage[];
  /** Messages this device sent. */
  sent(filter?: MessageFilter): SimMessage[];
  lastMessage(filter?: MessageFilter): SimMessage | undefined;
  waitForMessage(filter?: MessageFilter, options?: WaitOptions): Promise<SimMessage>;
  screenshot(file?: string): Promise<Buffer>;
}

export class Sim {
  readonly server: Server;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /** URL of the sim page. */
  readonly url: string;
  /** The screen (device 0). */
  readonly screen: Device;

  addPhone(profile?: PhoneProfile): Promise<Device>;
  dropPhone(phone: number | Device): Promise<void>;
  reconnect(phone: number | Device, options?: { timeout?: number }): Promise<Device>;
  device(id: number): Device;
  /** Connected phones, by id. */
  phones(): Device[];

  pause(): Promise<void>;
  resume(): Promise<void>;
  setPremium(phone: number | Device): Promise<void>;
  setNickname(phone: number | Device, nickname: string): Promise<void>;
  setAdFill(fill: boolean): Promise<void>;
  deviceMotion(phone: number | Device, data: Record<string, number>): Promise<void>;
  setSafeArea(area: { top: number; left: number; bottom: number; right: number }): Promise<void>;
  /** Platform snapshot: devices, players, paused, ads, master, high scores, persistent data. */
  state(): Promise<Record<string, any>>;

  mark(): number;
  events(filter?: EventFilter): SimEvent[];
  messages(filter?: MessageFilter): SimMessage[];
  lastMessage(filter?: MessageFilter): SimMessage | undefined;
  waitForEvent(filter: EventFilter, options?: WaitOptions): Promise<SimEvent>;
  waitForMessage(filter: MessageFilter, options?: WaitOptions): Promise<SimMessage>;
  ads(): AdRecord[];

  consoleMessages(): ConsoleEntry[];
  /** console.error calls, uncaught exceptions ('pageerror') and API-reported errors ('jserror') from every frame. */
  consoleErrors(options?: { ignore?: (RegExp | string)[] }): ConsoleEntry[];

  screenshot(file?: string, options?: { of?: 'page' | 'screen' | number }): Promise<Buffer>;
  cdp(): Promise<CDPSession>;
  close(): Promise<void>;
}

export function launch(options: LaunchOptions): Promise<Sim>;

export interface ServerOptions {
  build: string;
  /** Default 8080; 0 picks a free port. */
  port?: number;
  /** Default '127.0.0.1'. */
  host?: string;
  apiVersion?: string;
  api?: 'builtin' | 'official';
  log?: (line: string) => void;
}

export interface Server {
  root: string;
  port: number;
  origin: string;
  simUrl: string;
  apiVersions(): string[];
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<Server>;
export function checkBuildDir(dir: string): string;
export function rewriteApiTags(html: string, apiVersion?: string): { html: string; versions: string[] };
export const IMPLEMENTED_API_VERSION: string;

export function launchBrowser(options?: {
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  mute?: boolean;
  args?: string[];
}): Promise<Browser>;
