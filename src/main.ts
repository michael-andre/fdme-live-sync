import { Menu, Tray, app } from "electron";
import log from "electron-log/main";
import * as path from "path";
import { Subscription } from "rxjs";
import { FDMEProvider } from "./fdme-provider";
import { LiveSyncConsumer } from "./live-sync-consumer";
import { ScorepadProvider } from "./scorepad-provider";
import { observeActiveMatchCode } from "./match-code";

export type AppCheckTokenRequest = Readonly<{ appId: string; }>
export type AppCheckToken = Readonly<{ token: string, expiresInMillis: number }>;

let appTray: Tray | undefined;
let updatesSub: Subscription | undefined;

log.initialize({ preload: true });
Object.assign(console, log.functions);

app.whenReady().then(() => {

  const testMode = app.commandLine.getSwitchValue("mode") == "test";
  if (testMode) console.debug("Running in test mode");
  const isDev = app.commandLine.getSwitchValue("dev") == "true";
  if (isDev) console.debug("Running in dev mode");

  // Configure tray icon
  appTray = new Tray(path.join(__dirname, "..", "assets", "icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip("Synchronisation FDME");
  appTray.setContextMenu(contextMenu);

  // Process updates
  const fdmeUpdates = new FDMEProvider(testMode, isDev).observeUpdates();
  const scorepadUpdates = new ScorepadProvider(isDev).observeUpdates();
  const matchCode = observeActiveMatchCode();

  updatesSub = new Subscription();
  updatesSub.add(new LiveSyncConsumer().subscribe(fdmeUpdates, scorepadUpdates, matchCode));
  //updatesSub.add(new LocalBroadcastConsumer("192.168.0.1", isDev).subscribe(updates));
  
});

app.on("before-quit", function () {
  updatesSub?.unsubscribe();
  appTray?.destroy();
});

app.on("window-all-closed", () => {
  app.dock?.hide();
});

export type MatchUpdate = Partial<{
  homeScore: number,
  awayScore: number,
  chrono: number,
  period: number,
  chronoStarted: boolean
}>;