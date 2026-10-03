import type { ParameterOverrides } from '../contracts.js';

/**
 * 決定要不要把專案的耗材顏色交給 CLI。
 *
 * BambuStudio CLI（02.07.01.62，`src/BambuStudio.cpp` 的 `disable_wipe_tower_after_mapping`）
 * 切 Bambu 專案 3MF 時，若 `--load-filaments` 載入的耗材設定**名稱全部相同**，會判定
 * 「所有耗材都對應到同一卷料」而強制關掉擦料塔 —— `enable_prime_tower` 覆寫也一起被吃掉。
 * 唯一會把它翻回來的條件，是命令列另外給了 `filament_colour` 且不只一種顏色。
 *
 * GUI 沒有這個問題，因為它知道專案每一格的顏色。最常見的情形是五格都選 Generic PLA、
 * 只是顏色不同：此時把專案自己的顏色原樣交給 CLI，切出來才會跟 GUI 一樣有擦料塔。
 *
 * 只在這個情形才傳。命令列一帶顏色，CLI 也會依顏色重算換色沖洗量；其他情形照舊交給
 * 專案自己的設定，不多做一件 GUI 不會做的事。使用者自己覆寫了 `filament_colour` 時不介入。
 */
export function filamentColourArgs(options: {
  readonly filamentPresets: readonly string[];
  readonly projectColours: readonly string[] | undefined;
  readonly overrides: ParameterOverrides;
}): readonly string[] {
  if ('filament_colour' in options.overrides) return [];
  if (new Set(options.filamentPresets).size !== 1) return [];

  const colours = options.projectColours ?? [];
  const distinct = new Set(
    colours.map((colour) => colour.trim().toUpperCase()).filter((colour) => colour !== ''),
  );
  if (distinct.size < 2) return [];

  return [`--filament-colour=${colours.join(';')}`];
}
