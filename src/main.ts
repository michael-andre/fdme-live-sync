import { Menu, Tray, app } from "electron";
import * as log from "electron-log/main";
import { merge } from "lodash";
import * as path from "path";
import { Subscription, merge as mergeObservables, scan } from "rxjs";
import { FDMEProvider } from "./fdme-provider";
import { LiveSyncConsumer } from "./live-sync-consumer";
import { ScorepadProvider } from "./scorepad-provider";
import { LocalBroadcastConsumer } from "./local-broadcast";

export type AppCheckTokenRequest = Readonly<{ appId: string; }>
export type AppCheckToken = Readonly<{ token: string, expiresInMillis: number }>;

let appTray: Tray | undefined;
let updatesSub: Subscription | undefined;

log.initialize({ preload: true });
Object.assign(console, log.functions);

app.whenReady().then(() => {

  const testMode = app.commandLine.getSwitchValue("mode") == "test";
  if (testMode) console.debug("Running in test mode");

  // Configure tray icon
  appTray = new Tray(path.join(__dirname, "..", "assets", "icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip("Synchronisation FDME");
  appTray.setContextMenu(contextMenu);

  // Process updates
  const updates = mergeObservables(
    new FDMEProvider(testMode).observeUpdates(),
    new ScorepadProvider().observeUpdates()
  ).pipe(
    scan((state, update) => {
      if (update == null) return {};
      else return merge(state, update);
    }, {} as Partial<MatchUpdate>)
  );
  updatesSub = new Subscription();
  updatesSub.add(new LiveSyncConsumer().subscribe(updates));
  updatesSub.add(new LocalBroadcastConsumer("192.168.0.1").subscribe(updates));
  
});

app.on("before-quit", function () {
  updatesSub?.unsubscribe();
  appTray?.destroy();
});

app.on("window-all-closed", () => {
  app.dock?.hide();
});

export type MatchUpdate = {
  matchCode: string,
  homeScore: number,
  awayScore: number,
  chrono: number
};