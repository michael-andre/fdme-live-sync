import { Menu, Tray, app } from "electron";
import * as log from "electron-log/main";
import { merge } from "lodash";
import * as path from "path";
import { Subscription, combineLatest, scan, startWith, tap } from "rxjs";
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
  const fdmeUpdates = new FDMEProvider(testMode).observeUpdates();
  const scorepadUpdates = new ScorepadProvider(testMode).observeUpdates();
  const updates = combineLatest([ fdmeUpdates, scorepadUpdates.pipe(startWith(null)) ])
    .pipe(
      scan((state, [ fdmeUpdate, scorepadUpdate ]) => {
        if (fdmeUpdate == null) return {};
        else return merge(state, fdmeUpdate, scorepadUpdate);
      }, {} as Partial<MatchUpdate>),
      tap(u => { if (testMode) console.debug(`Combined update: ${JSON.stringify(u)}`); }),
    );

  updatesSub = new Subscription();
  updatesSub.add(new LiveSyncConsumer().subscribe(updates));
  updatesSub.add(new LocalBroadcastConsumer("192.168.0.1", testMode).subscribe(updates));
  
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
  chrono: number,
  period: number,
  chronoStarted: boolean
};