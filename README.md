# Bambu Studio companion MCP

讓 AI 用 Bambu Studio 的參數、切片器與模型檢查能力工作。

`@vibe/bambu-mcp`｜stdio transport｜16 個工具｜不連印表機

---

## 為什麼需要這一包

社群已經有多個 Bambu MCP，但幾乎都是**印表機遙控**（MQTT 開燈、暫停、看溫度），不碰切片參數。少數會呼叫 BambuStudio CLI 的，切出來的參數是錯的。

### BambuStudio CLI 不解析 preset 繼承

Bambu Lab 的原廠 preset 是四層繼承結構。葉節點只宣告數十個 key，其餘全部繼承：

```
0.20mm Standard @BBL X1C  <-  fdm_process_single_0.20  <-  fdm_process_single_common  <-  fdm_process_common
        (50 keys)                                                                            (大部分設定在這)
```

用 `--load-settings` 把葉節點交給 CLI 時，**`inherits` 不會被解析**。只有葉節點自己宣告的 key 生效，其餘全部掉回執行檔內建的 `StaticPrintConfig` 預設值 —— 不是 Bambu Lab 原廠 preset 的值。

實測（Bambu Lab X1 Carbon 0.4 nozzle ／ 0.20mm Standard @BBL X1C ／ Bambu PLA Basic ／ 20 mm 方塊）：

| 參數 | 直接餵原始 preset | 先展平繼承鏈 |
|---|---|---|
| `sparse_infill_density` | 20%（內建預設） | **15%（原廠 preset）** |
| `top_shell_layers` | 4 | **5** |
| `elefant_foot_compensation` | 0 | **0.15** |
| `enable_arc_fitting` | 0 | **1** |
| `brim_width` | 0 | **5** |
| 列印時間 | 10m 11s | **8m 45s** |

這就是 [bambulab/BambuStudio#1704](https://github.com/bambulab/BambuStudio/issues/1704)（CLI 與 GUI 切片結果不一致）的成因，至今未修。

**本 server 每次切片都先展平三種 preset 再交給 CLI**，切完再從產物 3MF 讀回實際生效的設定做稽核。

### 機型 G-code 不在 preset 裡

BambuStudio 02.07 起，機型專屬的 G-code（`machine_start_gcode`、`change_filament_gcode`、`layer_change_gcode`、`machine_end_gcode`、`time_lapse_gcode`、`wrapping_detection_gcode`）從 preset JSON 拆了出去，改在 `system/BBL.json` 另外登記成 `<preset 名稱> template <key>` 條目（本機 89 條，分屬 29 個機型）。葉節點本身不宣告這些 key，只走 `inherits` 會一路退回 `fdm_machine_common` 的通用開機段（`G28`、`G29`、`M109 S205`、在 X10 畫兩條擠出線）—— 那不是任何一台 Bambu 機器的開機程序。

展平時每一層先套自己的本體，原廠層再套以該層命名的模板。子層的模板蓋過父層的（X1 Carbon 0.6 有自己的模板、同時繼承 0.4），沒有模板的子層沿用父層的（P2S 0.2／0.6／0.8 都用 P2S 0.4 的）；使用者 preset 自訂的 G-code 不會被原廠模板蓋掉。`bambu_resolve_preset` 的來源欄位會寫出模板條目名稱。P2S 0.4 的六段 G-code 與 GUI 專案設定逐字相同。模板不是可選用的 preset，不會出現在 `bambu_list_presets`。

### CLI 會自己關掉擦料塔

切 Bambu 專案 3MF 時，若 `--load-filaments` 載入的耗材設定**名稱全部相同**（最常見：五格都是 Generic PLA，只是顏色不同），CLI 會判定「全部對應到同一卷料」而強制關掉擦料塔，`enable_prime_tower` 覆寫也一起失效。唯一會讓它保留的條件，是命令列另外給了不只一種顏色（`src/BambuStudio.cpp` 的 `disable_wipe_tower_after_mapping`）。GUI 沒有這個問題，因為它看得到每一格的顏色。

所以在這個情形下，本 server 會把專案 3MF 自己存的耗材顏色交給 CLI，並在 `warnings` 註明。其他情形不介入：命令列一帶顏色，CLI 也會依顏色重算換色沖洗量。

一盤四色專案（P2S 0.4 ／ 0.20mm Standard @BBL P2S ／ 5 × Generic PLA，四個物件、換色 34 次）的實測：

| | 只展平繼承鏈 | 本 server | GUI |
|---|---|---|---|
| 開機／換色／層切換 G-code | `fdm_machine_common` 通用版 | 與 GUI 逐字相同 | — |
| 擦料塔 | 關 | 開 | 開 |
| 耗材合計 | 40.10 g | 43.68 g | 43.68 g |
| 總時間 | 2h 6m 14s | 2h 18m 8s | 2h 18m 8s |

`bambu_slice` 回報的耗材是各色加總（含換色沖洗與擦料塔，與 GUI「切片結果」的 Total 欄相同），多色時另以 `filamentBreakdown` 逐色列出並對應耗材槽。

### Bambu Studio 沒有 plugin API

[bambulab/BambuStudio#9614](https://github.com/bambulab/BambuStudio/issues/9614) 正是在要求「Open API or Plugin System for LLM/MCP Integration」，目前 open、無官方回應。

所以讓 AI 調整的參數進到 GUI 只有一條合法途徑：寫入使用者 profile 目錄，Bambu Studio 啟動時會掃描。`bambu_save_user_preset` 做的就是這件事。

已實機驗證：寫入 `user/<profileId>/process/` 後重啟 Bambu Studio，process 下拉選單頂端會多出 **User presets** 區段並列出該 preset。

一個容易誤判的地方：**preset 依機器相容性過濾顯示**。繼承 X1C process 的自訂 preset，在機器選成 P2S 0.2 nozzle 時不會出現在清單裡 —— 那不是寫入失敗，是過濾。看不到時先確認目前選的機器與 `inherits` 的來源相容。

### 非破壞性編輯不需要幾何引擎

Bambu Studio 的挖除體、局部參數區與支撐控制，**不是把原始網格改掉**，而是存成「多一個零件 + 一個 subtype 標籤」：

```xml
<part id="2" subtype="negative_part">
  <metadata key="name" value="hole"/>
  <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
</part>
```

所以產生這些編輯不需要 boolean 運算引擎，也不需要驅動 GUI —— 寫一個 3MF 就好。`bambu_compose_model` 做的就是這件事。

五個 subtype 取自 BambuStudio 原始碼 `src/libslic3r/Model.cpp` 的 `ModelVolume::type_to_string()`：
`normal_part`、`negative_part`、`modifier_part`、`support_blocker`、`support_enforcer`。

**這個清單必須封閉。** 讀取端 `type_from_string()` 對認不得的字串是靜默回退：

```cpp
// Default value if invalud type string received.
return ModelVolumeType::MODEL_PART;
```

拼錯一個字母，「挖掉一塊」就變成「加上一塊實心」，而且沒有任何錯誤訊息。實測同一塊幾何蓋住 20 mm 立方體頂部：

| subtype | max_z_height | 層數 | 耗材 |
|---|---|---|---|
| （無此零件） | 20.00 | 100 | 3.72 g |
| `negative_part` | **15.00** | 75 | 2.96 g |
| `normal_part` | **25.00** | 125 | 9.39 g |

因此 `bambu_compose_model` 只接受這五個字串，其餘一律拒絕。

---

## 工具

### 參數

| 工具 | 用途 |
|---|---|
| `bambu_plan_settings` | **事前**：說出目標（穩妥不失敗／省時／強度／外觀／省料），回傳依失敗模式分組的參數規劃 |
| `bambu_optimize_print_in_place` | **一鍵套用**：從目前或指定 preset 建立齒輪／活動件的保守穩定版；保留既有尺寸校正，不盲目開全域 brim |
| `bambu_describe_parameters` | 參數在做什麼、單位、建議區間、**調高與調低各自的代價**、牽連參數 |
| `bambu_diagnose` | **事後**：從現象（翹邊、牽絲、層裂、象腿、頂面有洞、印到一半被撞倒……）推有序的處置建議 |
| `bambu_resolve_preset` | 展平繼承鏈，並標明每個值來自哪一層 |
| `bambu_compare_presets` | 兩個 preset 展平後的差異 |
| `bambu_list_presets` | 列出可選用的 preset（過濾掉純繼承的中間層與 G-code 模板條目） |
| `bambu_save_user_preset` | 寫入使用者 preset，重啟後出現在 Studio 下拉選單 |

### 切片

| 工具 | 用途 |
|---|---|
| `bambu_slice` | 展平後切片，回報層數／時間／耗材（多色時另列每一色），並逐項稽核覆寫有沒有生效 |

### 模型

| 工具 | 用途 |
|---|---|
| `bambu_inspect_model` | STL／3MF 幾何：三角形數、外框、體積、表面積、網格是否封閉、零件清單 |
| `bambu_check_printability` | 超範圍、非流形、陡峭懸空、底面積過小、高寬比、薄特徵、翹曲風險 |
| `bambu_measure_clearance` | **零件之間的最小間隙**：列印即組裝的機構印完會不會黏死，附補償建議 |
| `bambu_compose_model` | 組出含挖除體／修飾體／支撐控制的 Bambu 專案 3MF |
| `bambu_inspect_project` | 讀回 3MF 的物件與零件結構，驗證寫進去的東西真的在裡面 |

### 搜尋

| 工具 | 用途 |
|---|---|
| `bambu_search_models` | Thingiverse 官方 API；MakerWorld／Printables 只給查詢連結 |

### 狀態

`bambu_get_status` —— 資料目錄、切片器是否可用、preset 數量、Studio 目前選用的機器與材料、允許的模型目錄、各平台整合層級。

---

## 設定

`dist/` 不進版控，所以第一次使用要先建置：

```bash
pnpm install && pnpm build
```

註冊給 Claude Code：

```bash
claude mcp add -s local bambu \
  -e BAMBU_MODEL_DIR="$HOME/Desktop/bambu-work" \
  -e BAMBU_OUTPUT_DIR="$HOME/Desktop/bambu-work/out" \
  -e BAMBU_STUDIO_PATH="/Applications/BambuStudio.app/Contents/MacOS/BambuStudio" \
  -- "$(which node)" "$PWD/dist/index.js"
```

**為什麼不寫進工作區根的 `.mcp.json`。** 原本那份寫的是 `"command": "node"` 加上
`${CLAUDE_PROJECT_DIR}/...`，兩個都會炸：

- `${CLAUDE_PROJECT_DIR}` 這個變數目前的 Claude Code 不會提供，`claude mcp list` 會直接報
  `Missing environment variables: CLAUDE_PROJECT_DIR`，server 起不來。
- 裸 `node` 在有 nvm／conda 之類 shell 函式的環境會解析到錯的版本（本機實測是 v14.15.1），
  而且是靜默失敗。

ENV-001「不寫死使用者絕對路徑」的原意是可攜性，但一份起不來的設定沒有可攜性可言。
所以改用 `claude mcp add -s local`：路徑由上面那行指令在當下解析（`which node`、`$PWD`），
指令本身仍然可攜，落地的設定則是這台機器上正確的絕對路徑。

接上之後先呼叫 `bambu_get_status` 確認 `allowedModelRoots` 與 `dataDir` 是預期的值。

**權限注意**：macOS 會限制程式存取 `~/Downloads`、`~/Documents`、`~/Desktop`。若 `bambu_inspect_model` 回 EPERM，代表 MCP Host 沒有該目錄的存取權 —— 到系統設定授予，或把 `BAMBU_MODEL_DIR` 指到不受限的目錄。

一個實測到的陷阱：TCC 的授權對象是**執行檔身分**，不是「Claude」這個名字。系統設定裡可能同時有
`Claude`（桌面 app）與 `claude`（CLI）兩筆，只開前者的資料夾權限，CLI 這邊照樣 EPERM；
而且授權變更要程序重啟才生效。被擋住時 `stat` 仍然會成功、只有 `open`／`readdir` 失敗，
所以「檔案存在」不代表「讀得到」。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `BAMBU_DATA_DIR` | 依平台自動偵測 | BambuStudio 資料目錄 |
| `BAMBU_STUDIO_PATH` | 依平台自動偵測 | 切片器執行檔 |
| `BAMBU_OUTPUT_DIR` | 未設定 | 切片產物輸出目錄。**未設定時 `bambu_slice` 一律拒絕執行** |
| `BAMBU_MODEL_DIR` | 未設定 | 允許讀取模型的目錄，可用平台分隔符給多個。**未設定時所有讀檔工具一律拒絕** |
| `THINGIVERSE_TOKEN` | 未設定 | [Thingiverse 開發者 Token](https://www.thingiverse.com/developers)；未設定時只回查詢連結 |
| `BAMBU_SLICE_TIMEOUT_MS` | `300000` | 單次切片逾時 |

平台預設路徑：

| | 資料目錄 | 執行檔 |
|---|---|---|
| macOS | `~/Library/Application Support/BambuStudio` | `/Applications/BambuStudio.app/Contents/MacOS/BambuStudio` |
| Windows | `%APPDATA%\BambuStudio` | `%ProgramFiles%\Bambu Studio\bambu-studio.exe` |
| Linux | `~/.config/BambuStudio` | `~/.local/bin/bambu-studio` |

---

## 邊界

- **不控制實體印表機。** 不連 MQTT、不上傳檔案、不啟動列印。實體機器的操作是不可逆且有物理風險的，刻意不放進工具面。要遙控印表機請另外接 [griches/bambu-mcp](https://github.com/griches/bambu-mcp)（MIT）。
- **只讀允許目錄內的檔案。** `BAMBU_MODEL_DIR` 之外的路徑一律拒絕，並且擋 `..` 穿越與同前綴的鄰居目錄（`/models-evil` 不會通過 `/models` 的檢查）。
- **只寫使用者 profile 目錄與輸出目錄。** 原廠 preset 目錄永不寫入；同名使用者 preset 不會被靜默覆蓋。
- **不把瀏覽器自動化冒充 API。** MakerWorld 與 Printables 沒有官方公開介面，就只回查詢連結，不用 cookie、私有 endpoint 或畫面 selector 繞過。這是 `vibe/mcp` 架構原則第 5 條。
- **不猜症狀。** `bambu_diagnose` 比對不到已知症狀時直接說沒把握並附上可選清單，因為猜錯會給出讓情況更糟的建議。
- **不做破壞性幾何運算。** `bambu_compose_model` 產生的是「本體 + 標記過的附加零件」，boolean 由切片器在切片時處理。真正要算出新網格（合併後的 mesh、切割結果、文字浮雕）不在範圍內 —— 那需要幾何運算引擎，該交給 Blender 或 OpenSCAD。
- **間隙量測只吃 3MF。** STL 是一鍋沒有分組的三角形，沒有零件邊界可分，`bambu_measure_clearance` 會直說量不了而不是回一份空報告。判定「同一顆實體」的依據是表面接觸或互相穿透；完全被另一個零件包住、但中間隔著空隙的結構（例如封閉腔室裡的自由滾珠）會被算成兩顆獨立實體，那在幾何上也確實是兩顆。
- **不就地修改既有 3MF 專案。** `bambu_compose_model` 的本體來源是 STL，產出是全新的 3MF。要在既有 Bambu 專案上加零件（同時保留它的塗刷支撐、多盤配置、色彩等狀態）沒有實作；`bambu_inspect_project` 可以讀任何 Bambu 專案 3MF 的零件結構，但不會寫回去。

---

## 驗證

```bash
pnpm verify
```

`typecheck` → `test`（208 項）→ `build` → `smoke`。smoke 用 `tests/fixtures/datadir` 的假資料目錄，沒裝 Bambu Studio 的機器（含 CI）也能跑。

### 端到端驗證

需要本機真的裝了 Bambu Studio，會實際啟動切片器。因此**不納入 `pnpm verify`**：

```bash
node scripts/verify-real-slicer.mjs
```

它證明六件事：繼承展平後產物採用的是原廠 preset 真值、機型有 G-code 模板時產物的開機 G-code 就是那份模板、參數覆寫真的落到產物上、稽核會誠實回報沒生效的項目、挖除體真的改變了幾何，以及修飾體的參數只作用在它涵蓋的區域。

最近一次實跑（P2S 0.4 ／ 0.20mm Standard @BBL P2S ／ Generic PLA ／ 20 mm 方塊）：

```
繼承鏈：0.20mm Standard @BBL P2S <- fdm_process_single_0.20
        <- fdm_process_single_common <- fdm_process_common
展平後 191 個設定

基準：100 層、1305s、3.6 g
  ✓ sparse_infill_density: preset "15%"  → 產物 "15%"
  ✓ top_shell_layers:      preset "5"    → 產物 "5"
  ✓ elefant_foot_compensation: preset "0.15" → 產物 "0.15"
  ✓ brim_width:            preset "5"    → 產物 "5"

開機 G-code 來源：Bambu Lab P2S 0.4 nozzle template machine_start_gcode
  ✓ 產物的開機 G-code 與原廠模板逐字相同

覆寫後：72 層、1077s、層高 0.28
  ✓ layer_height:           "0.28" → "0.28"
  ✓ sparse_infill_density:  "10%"  → "10%"
  ✓ wall_loops:             "4"    → "4"
  ✗ layer_hieght（故意打錯）→ 已攔下並標為未生效

非破壞性零件：
  讀回：cube=normal_part、topcut=negative_part
  基準立方體：max_z 20 mm、100 層、3.6 g
  挖掉頂部後：max_z 15 mm、 75 層、2.84 g

局部參數區：
  讀回：dense-half=modifier_part，設定 {"sparse_infill_density":"90%"}
  填充路徑長度：修飾側 371 mm、另一側 77 mm（比值 4.81）
  耗材：3.6 g → 6.23 g
```

修飾體的判準刻意用**空間分布**而不是總耗材：只看總量無法排除「參數被套到整個物件」這種錯法。同一層裡左右兩半的填充路徑長度差近 5 倍，才證明它真的只作用在自己涵蓋的區域。

### 目標導向規劃

`bambu_diagnose` 是**事後**的：印壞了，從現象回推成因。`bambu_plan_settings` 是**事前**的：還沒印，先說要什麼。

兩者刻意分開，因為思路相反 —— 診斷要收斂到單一成因，規劃要在互相衝突的目標之間取捨。同一個參數在不同目標下方向可能完全相反：求快要讓風扇全開好縮短層時間，ABS 求不翹卻要把它關掉。

五個目標：`safe`（穩妥不失敗）、`fast`、`strong`、`surface`、`economical`。

輸出依**在對付什麼**分組，而不是平鋪一長串參數：附著與翹曲／噴頭碰撞／表面品質／結構強度／時間／耗材。

三個設計重點：

1. **回報目前值與它的形狀。** 不少參數在 preset 裡是每噴頭一項的陣列 —— 實測某台 P1S 的 `filament_z_hop` 是 `["nil","0.6"]`（`"nil"` 是字面值，代表未設定）。拿純量去覆寫多噴頭參數會落空，所以把現況擺在建議旁邊。
2. **依模型幾何追加。** 給了 `modelPath` 就先做可列印性分析：底面積過小 → 加寬 brim；細高件 → 外牆再降一級；陡峭懸空 → 才建議開支撐。沒給模型就只有基本組。
3. **alias 至少兩個字。** 曾用單字元 alias，結果「勉**強**」命中 `strong`、「顏色不**好看**」命中 `surface`。目標比對錯會把整組參數往反方向調，所以寧可漏比對也不誤比對；比對不到就回空並附上可選清單。

`safe` 目標特別處理兩個最貴的失敗模式：

- **翹起來** → brim、首層熱床溫度、首層速度
- **噴頭撞到已印物件** → `filament_z_hop`、`filament_z_hop_types`（Spiral Lift）、`reduce_crossing_wall`（原廠預設是關的）、懸空降速、單層最短時間

懸空降速歸在「防撞」而不是「品質」是刻意的：**捲翹起來的邊緣正好卡在下一層的噴頭路徑上，碰撞往往是這樣開始的。**

列舉型的建議值（`Spiral Lift`、`outer_only`、`enabled`）全部對照過 `PrintConfig.cpp` 的 `enum_values` 與實際 preset，不是憑印象寫的。

### Print-in-place 自動穩定版

`bambu_plan_settings` 只說明方向；`bambu_optimize_print_in_place` 會建立真正可在 Studio 選用的使用者 process preset。它把「小零件脫床後變鳥巢」與「頂面出現規律怪紋」收斂成八項可安全自動套用的值：

- 首層外框 `20 mm/s`、首層填充 `30 mm/s`。
- 外牆不超過 `60 mm/s`，但原值若更慢不會反向提高。
- 開啟懸空減速與 `reduce_crossing_wall`。
- 頂面固定 `monotonicline`，`ironing_type=no ironing`，`fuzzy_skin=none`。

若來源是既有使用者 preset，尺寸、孔洞與象腿校正會保留；新 preset 仍直接繼承原廠來源，避免堆出多層使用者繼承。

工具預設會明確寫入 `brim_type=no_brim`。Bambu 的內建預設是 Auto Brim，而 print-in-place 的齒輪間隙可能被整圈 brim 黏死；明確帶 `includeBrimEars=true` 才會改寫為 `brim_type=brim_ears`、`brim_width=5`、`brim_object_gap=0.15`，並提醒檢查第一層。Bambu Studio 的 brim 列舉與頂面圖樣值以官方 [`PrintConfig.hpp`](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/PrintConfig.hpp) 及 [`fdm_process_common.json`](https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/process/fdm_process_common.json) 為準。

材料溫度、冷卻與流量也不自動改：普通 PLA、Silk PLA 與 PETG 的安全值不同，必須先確認實際線材並分開校正。

### 範例：挖 M3 螺絲孔

```bash
node scripts/example-m3-hole.mjs
```

在 40×20×5 mm 固定片上挖兩個 Ø3.4 mm 的 M3 中等級通孔（ISO 273），然後**從切片產物的 G-code 量回實際孔徑**驗證 —— 產生檔案不算數。

BambuStudio 預設開 `enable_arc_fitting`，圓孔輸出成 G2／G3 圓弧，圓弧的 I／J 就是圓心偏移，所以孔徑可以直接由幾何算出而不必擬合取樣點。

實跑結果（P1S ／ 0.16mm High Quality ／ PLA Matte）：

```
組出 m3-bracket.3mf
  normal_part    plate       12 面
  negative_part  m3-hole-1   256 面
  negative_part  m3-hole-2   256 面
切片：31 層、3 g、線寬 0.42、孔徑補償 0

孔 1  圓心 (116.00, 126.00)  Ø3.398 mm（設計 Ø3.4，差 -0.002）
孔 2  圓心 (140.00, 126.00)  Ø3.398 mm（設計 Ø3.4，差 -0.002）
中心距 24.000 mm（設計 24）
```

刀路孔徑與模型一致到 0.01 mm 以內。實際印出來會略小是材料收縮與擠出行為造成的，那是 `xy_hole_compensation` 的工作 —— 先印校正件量實際偏差再決定補償值，不要憑感覺調。

常用 M3 孔徑：通孔中等級 Ø3.4、精級 Ø3.2、攻牙入塑膠 Ø2.5、熱熔銅套依規格（常見 Ø4.0）。

---

## 更新 key 基準

`src/domain/parameters/known-keys.ts` 是產生物，內含 568 個 BambuStudio 展平後的設定 key，用於打錯字偵測。BambuStudio 改版新增參數時重新產生：

```bash
node scripts/verify-real-slicer.mjs   # 產出一份 .gcode.3mf
# 從產物的 Metadata/project_settings.config 取 key 列表覆寫該檔
```

它不是「所有機種的所有 key」—— 多噴頭與其他機型可能有額外 key，所以 `isKnownParameterKey` 為 false 是警告而不是錯誤。

---

## 架構

```
src/
  domain/        純邏輯，不認識檔案系統、子行程與網路
    presets/     繼承展平與機型 G-code 模板（本 server 的核心）
    parameters/  參數知識層、症狀診斷、key 基準
    slicing/     覆寫路由、耗材顏色交接、G-code 統計、ZIP 讀寫
    model/       STL 解析、可列印性分析、原始形狀、3MF 組裝與讀回
  ports/         PresetStore、Slicer、ModelCatalog
  adapters/      BambuStudio CLI、Node preset store、Thingiverse、交接目錄
  application/   BambuService
  server/        工具註冊與 schema
```

3MF 是 ZIP 容器，ZIP 讀寫器、STL 解析與 3MF 組裝都手寫，runtime 依賴只有 MCP SDK 與 zod。

## 相關

- [MCP 專案群](../README.md)
- [MCP 專案群架構](../docs/architecture.md)
