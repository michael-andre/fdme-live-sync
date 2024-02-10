import * as path from "path";
import { Menu, MenuItem, Tray, app, nativeImage, nativeTheme } from "electron";
import { Observable, combineLatest, distinctUntilChanged, startWith } from "rxjs";
import { SourceState } from "./main";

export function configureTrayIcon(scoreSheetState: Observable<SourceState>, scorepadState: Observable<SourceState>): () => void {
  const appTray = new Tray(getTrayImage());

  appTray.setToolTip("Synchronisation FDME");
  nativeTheme.on("updated", () => {
    appTray.setImage(getTrayImage());
  });

  const closeItem = new MenuItem({ label: "Fermer", type: "normal", role: "quit", click: () => app.quit() });

  const statesSub = combineLatest([
    scoreSheetState.pipe(distinctUntilChanged(), startWith<SourceState>("off")),
    scorepadState.pipe(distinctUntilChanged(), startWith<SourceState>("off")),
  ]).subscribe({
    next: ([scoreSheetState, scorepadState]) => {
      const menu = new Menu();
      menu.append(new MenuItem({ label: "FDME", enabled: false, icon: getMenuIcon(scoreSheetState) }));
      menu.append(new MenuItem({ label: "Scorepad", enabled: false, icon: getMenuIcon(scorepadState) }));
      menu.append(closeItem);
      appTray.setContextMenu(menu);
    }
  });

  return () => {
    statesSub.unsubscribe();
    appTray.destroy()
  };
}

function getTrayImage() {
  return path.join(__dirname, "..", "assets", nativeTheme.shouldUseDarkColors ? "icon-dark.png" : "icon-light.png");
}

function getMenuIcon(state: SourceState) {
  return nativeImage.createFromPath(
    path.join(__dirname, "..", "assets", `source-${state}.png`)
  ).resize({ height: 16, width: 16 });
}