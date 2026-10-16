# nav-recorder 執行報告：token 消耗與改進建議

> 來源：一次實際使用 nav-recorder skill 的 session（2026-10-14，專案 ESD）。
> 任務：登入本機 dev server，走選單進到 `/SignOff/SignOffSetSecond`，選好起始職務並確認畫面。
> 用途：找出 nav-recorder 在「登入 → 導覽到目標畫面」這條常見路徑上哪裡耗 token，作為改進依據。

## 1. 量測方式

- 數字取自該 session 的 transcript：每個步驟讓 context 增加了多少 token（下一次呼叫的 context 總量 − 這一次的 context 總量）。
- 每筆數字含當步我（agent）的少量文字，約 100~400 token。不是計費金額。
- 但每一筆都會留在 context 裡，被之後每一輪重讀，所以大輸出的實際成本遠高於它的名目大小。
- 範圍：載入 skill 到停在編輯頁、選好起始職務（第 1~33 個呼叫）。之後為驗證我自己改的程式碼而做的呼叫，不屬於 nav-recorder，不計入。

## 2. 消耗總覽

範圍內合計約 **56.3k token**。

| 分類 | token | 佔比 | 內容 |
|---|---:|---:|---|
| **F 簽核設定列表的 `browser_snapshot`** | **20,107** | 36% | 193 列的表格，整頁 dump 回來 |
| **A 載入 SKILL.md** | **17,527** | 31% | 檔案 41.9 KB，整份進 context |
| B nav-recorder CLI | 6,371 | 11% | `execute-start/next/report`、list、routes |
| C 登入的 Playwright 動作 | 5,682 | 10% | 10 個呼叫：navigate、fill×3、click×2、evaluate×2、snapshot、wait |
| G 進編輯頁、選職務、截圖 | 3,047 | 5% | |
| E 走選單（Home snapshot＋點擊＋find） | 2,818 | 5% | |
| D 確認 `_RDE` 有沒有覆寫 | 769 | 1% | |

其他實測數字：

- F 這一筆之後仍被重讀 54 輪，約 **108 萬** cache-read token。
- 失敗或無效呼叫（路徑被改寫、參數名錯）合計約 **1.6k**，另加 3 次無謂往返。
- 6 張全頁截圖，Read 每張約 2.3k，共約 14k（另加截圖呼叫約 1.9k）。這屬於驗證流程，不是 nav-recorder 的步驟。

## 3. 改進建議（依省量排序）

### 3.1 避免整頁 `browser_snapshot`（約 20k）

- skill 步驟 6 寫「每一下先 `browser_snapshot`」。落在列表頁就會把整張表 dump 進來。
- 這次的 snapshot 是 agent 自己選的，但 skill 的寫法在引導這個行為。
- 建議：
  - 預設改用 `browser_find`（`targetHint.clicks` 已有 `text` / `role`）。實測一次 `find` 約 400 token。
  - 讓 Companion 把整串點擊鏈組成一支 `browser_run_code` 腳本，一次呼叫走完，不用 5~6 次往返。
  - skill 明講「列表頁不要 snapshot」。

### 3.2 拆小 SKILL.md（約 17.5k）

- 這次只用到步驟 1、5、6，但整份都載入，包含步驟 0 onboarding、probe、pause/resume 和多張對照表。
- 建議拆成短的核心檔（查知識庫、執行迴圈、交棒），其餘放按需載入的 reference 檔。
- 常見路徑估計可以降到一半以下。這是用結構推估，沒有逐段量。

### 3.3 登入改成一次性腳本（約 5.7k，加 CLI 約 2.5k）

- 登入是確定性流程，卻靠 LLM 一步一步驅動，10 個 Playwright 呼叫每個都是完整往返。
- 建議 `execute-next` 對 `login-ui` 直接回一支完整腳本（登入＋storageReset＋回報），或讓 Companion 自己驅動瀏覽器。模型只看到一句 `ok`。

### 3.4 storage snapshot 不要回到對話裡（約 1.4k，另有外洩面）

- 範例的 `evaluate` 把整份 localStorage 回傳，**JWT token 也進了 transcript**。
- 這次沒有使用 `--storage-snapshot`，`execute-report` 仍回 `continue`，這步可能不必要。
- 建議讓腳本直接 POST 給 Companion，只回傳 key 數量；並確認這步是否必要。

### 3.5 文件與實際工具參數對齊（約 1.6k，3 次失敗往返）

- skill 範例寫 `ref`，這版 Playwright MCP 的欄位是 `target`。
- recipe 給的是 CSS selector，但 `browser_fill_form` 要的是 snapshot ref 或 target。
- 結果 `fill_form` 錯 2 次、`click` 錯 1 次。
- 建議在步驟 5 的動作對照表標出實際欄位名，並說明 CSS selector 該怎麼傳。

### 3.6 Windows Git Bash 路徑改寫，且 CLI 不報錯（約 1.4k）

- `--target-url /SignOff/...` 被轉成 `C:/Program Files/Git/SignOff/...`。
- CLI 回的是看起來正常的 `found: false` / `recipes: []`，要看到回傳的路徑才會發現。
- 建議：
  - CLI 偵測到 `C:/Program Files/Git` 前綴時直接報錯並提示。
  - skill 註明在 Windows 用 PowerShell，或設 `MSYS_NO_PATHCONV=1`。

### 3.7 區分冷進入與熱進入（單次可省約 24k）

- 全站預設是 `menu`，但同一個 session 登入後，直接 `browser_navigate` 回 `/SignOff/SignOffSetSecond` 就成功了，頁面從 sessionStorage 的 `params` 還原，省掉整段選單。
- 目前只有一次觀察，不確定是否通用。
- 建議 data-source 記錄分成「冷進入」和「同 session 熱進入」，熱的可直接 deeplink，必要時附上它依賴的 sessionStorage key。

## 4. 這次執行與 skill 的出入

- **沒有執行 skill 要求的寫回**：觀察到的進入方式沒有用 `data-source set` / `routes set` 落盤。因此 3.7 的觀察不在知識庫裡，下一個 agent 仍會走完整選單。
- **沒有使用 `routes recent` / `capture-recent`**：目標 route 已知，直接用 `routes get` 與 `list` 查，所以這兩個命令的成本沒有出現在上表。
- 登入使用 `login-ready` recipe，沒有針對這個畫面新建 recipe（`list --target-url` 只命中同 controller 的 `section` 層級）。

## 5. 預期效益

若 3.1、3.2、3.3 都做：

| 項目 | 現在 | 預期 |
|---|---:|---:|
| 列表頁 snapshot | 20.1k | 約 0.5~1k |
| 載入 skill | 17.5k | 約 7~9k（推估） |
| 登入動作與 CLI | 約 8k | 約 1.5~2k（推估） |

合計約可從 56k 降到 20k 上下。預期值是推估，沒有實際實作量測。
