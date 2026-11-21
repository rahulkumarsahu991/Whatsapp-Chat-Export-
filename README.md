# WhatsApp Chat Exporter

A clean, dark website (Tailwind CSS) that works like WhatsApp Web. It fits phones (including iPhone Safari), tablets and desktops:
**scan the QR → pick a group → see its chats, photos and videos by date → export everything.**

## Kaise chalayein (How to run)

1. **Double-click `start.bat`**, or double-click `index.html`, which waits for the server and then opens the app.
   The first run installs the packages, which takes a few minutes.
   If Node.js isn't installed system-wide, `start.bat` uses the portable copy in `%USERPROFILE%\WhatsAppChatExporter\node`.
2. The browser opens at **http://localhost:3000**. If it doesn't, open that address yourself.
3. On your phone, open WhatsApp → **Settings / ⋮ Menu → Linked devices → Link a device**, then scan the QR.
4. Once your chats load, click any **group** on the left.
5. Optionally set **From / To** dates, or use the quick chips: Today, 7 days, 30 days, This month.
6. Press **Download ZIP**. On phones and tablets, use the round **Export** button instead.
   - **Photos & videos ON** (default): one `.zip` file downloads straight to your Downloads. Inside are the Excel file and a `media/` folder with every photo, video, voice note, sticker and document. Extract it and the links in Excel open the files.
   - **Photos & videos OFF**: only the `.xlsx` file is downloaded.
   - A progress card shows how many media files are done. If the browser blocks the download, use **Download again**.

Inside the app you can click a photo or video to open it full size, play voice notes inline, and download documents.

Keep the black server window open while you use the site. Close it, or press `Ctrl+C`, to stop.

### Use it on your phone or another device

`start-mobile.bat` runs the same app on this PC and gives it a fixed `https://….ngrok-free.dev` link that opens anywhere. It has two doors:

| Link | Who | What they get |
|---|---|---|
| `https://<your-link>` | **Anyone you send it to** | Their **own** private, temporary login. They link their own WhatsApp and see only their own chats, never yours or anyone else's. |
| `https://<your-link>/owner` | **You** (Google sign-in with the Gmail you set up) | Your own saved WhatsApp login, the same one as on this PC |

1. **First time:** double-click `start-mobile.bat`. It downloads ngrok and opens the ngrok website.
   - Make a free ngrok account.
   - Paste your **Authtoken** into the black window.
   - Paste your free **domain**, from the Domains page.
   - Type the **Gmail** address that may use `/owner`.
2. **Every time after that:** double-click `start-mobile.bat`. The black window prints both links.
   - The first visit on a device shows an ngrok notice; tap **Visit Site**.
3. To change the token, link or Gmail, run `start-mobile.bat --setup`.

**How other people link their WhatsApp:**
- **On a computer:** scan the QR code with their phone (WhatsApp → Linked devices → Link a device).
- **On the same phone:**
  1. Tap **Link with phone number instead** and enter their number with country code.
  2. WhatsApp shows a notification; they type the 8-character code shown on the page.
     No notification? In WhatsApp go to Linked devices → Link a device → **Link with phone number instead**.

**Privacy for guests:** a guest's login is unlinked from their WhatsApp, and everything kept for them is deleted from this PC:
- when they press **Log out**;
- when their page has been closed for **20 minutes**;
- when a login was never linked after 15 minutes;
- when it has gone unused for 3 hours;
- when the app stops.

Up to **3 guests** can be logged in at a time. Each one runs its own hidden Chrome, using about 300 MB of memory.

Made fast for phones:
- Data is compressed, about 10 times smaller.
- Page files stay cached on the phone, so a repeat visit downloads only a small page.
- A group shows its newest messages within a second or two, and older ones load in the background.
- On the link, photos show as small previews that come in batches. Tap one to open the full photo.

Good to know:
- The link works only while this PC is on and `start-mobile.bat` is running.
- The free ngrok plan allows about **1 GB of data and 20,000 requests a month**, shared by everyone who uses the link. Excel exports and chats are small, but ZIPs full of videos use that up quickly.
- Anyone who has the plain link can use it, so only send it to people you trust. They can never see your chats.

**Demo mode:** `start-demo.bat` opens the same interface with sample groups and needs no login. Click the QR code to simulate a scan.

## Google Sheet sync (automatic)

Press the **sheet button (📊)** next to Log out to copy all your chats into a Google Sheet. After that, new messages are added automatically every few seconds.
- Every **group** gets its own tab.
- All **personal chats** share one **Personal Chats** tab, with a "Chat" column.
- Columns: Date · Time · Day · Sender · Phone · Message · Type.
- **Old messages:** choose how far back to copy: 7 days, 30 days, 3 months, 1 year, or everything available. Copying everything can take a long time for big accounts.
- If the app was off, it catches up on the missed messages when it starts again. Nothing is written twice.
- Photos and videos show as "Photo" / "Video" with their caption. The files themselves are not uploaded.
- **Stop sync** keeps what is already in the sheet.

**For people using the shared link:** while sync is on, their WhatsApp stays linked to this PC, even after a restart, so their sheet keeps updating. To stop, they press **Stop sync**, **Log out**, or remove the device in WhatsApp → Linked devices. Up to 3 guests can be logged in at a time, syncing or not.

### One-time setup: the Google "bot" (owner of this PC only)

The app writes to sheets through a free Google **service account**, a bot with its own email. Each person shares their sheet with that email. Nobody hands over a Google password.

1. Open <https://console.cloud.google.com/> and sign in with your Google account.
2. At the top, click the **project picker**, then **New project**. Name it, for example `WhatsApp Sheet Sync`, and click **Create**. Then select that project.
3. Open <https://console.cloud.google.com/apis/library/sheets.googleapis.com> and click **Enable**.
4. Go to **IAM & Admin → Service Accounts → + Create service account**. Name it `sheet-bot`, click **Create and continue**, then **Done**. It needs no roles.
5. Click the new service account, then **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads.
6. Rename it to **`google-service-account.json`** and move it to **`C:\Users\<you>\WhatsAppChatExporter\`**.
7. Restart `start-mobile.bat` (or `start.bat`). The window then says `Google Sheets sync: ready (bot: …@….iam.gserviceaccount.com)`.

Keep that key file private: anyone who has it can write to the sheets shared with the bot. It is never uploaded to GitHub. If it leaks, delete the key in the Google console (step 5) and make a new one.

Google limits:
- The bot can make about 60 writes a minute. The app batches messages, so that is plenty.
- One spreadsheet holds up to 10 million cells, roughly 1.4 million messages.

## What the Excel file contains

| Sheet | Columns |
|---|---|
| **Chats** | S.No · Date · Time · Day · Sender Name · Phone Number · Message · Type · **Photos** (previews inside the row) · **Media Files** |
| **Members Summary** | Rank · Sender · Phone · Messages · Media · Share % · First / Last message |
| **Daily Activity** | Date · Day · Messages · Active members · activity bar |
| **Group Info** | Name, members, created date, description, period, media saved, export time |

**One row per post:** messages one person sends back to back in the same minute share one row, such as a photo and its text, or an album of photos. The Message cell holds all the text, Type says what is in the row (for example `Text + 2 Photos`), the Photos column shows up to 3 previews you can click to open the full file, and Media Files lists every file. The Members Summary and Daily Activity sheets still count every single message.

The header row is frozen and has filters. Your own messages are tinted green, and the dates are real Excel dates, so they sort correctly.
Media files are named `date_time_sender_type.ext`, so they sort by date in Explorer too.

## Good to know

- **Privacy:** everything runs on this computer. With `start.bat` only this computer can open it (`127.0.0.1`). With `start-mobile.bat` the link above reaches it through ngrok; your own login is only behind `/owner`. Chats and media are not uploaded to any server.
- **Login session:** the session is saved in `%USERPROFILE%\WhatsAppChatExporter`, outside OneDrive, so you don't need to scan again next time. Downloaded media is cached there too, so a file is only fetched once. **Log out** unlinks the device and deletes that cache.
- **Old media:** WhatsApp only keeps photos and videos on its servers for a limited time. Media your phone no longer has shows *Not available* in Excel and is counted in the export summary.
- **Old messages:** WhatsApp only gives a linked device the history your phone syncs to it. If you set a *From* date, the app keeps loading older messages until it reaches that date or the history runs out.
- **Phone numbers:** in some newer groups WhatsApp hides members' numbers. Those members show *Hidden (privacy)*, and their names still appear.
- **Slow internet:** WhatsApp Web gets up to 3 minutes to load, and the app retries by itself if the connection drops. Its files (~15 MB) are cached in `%USERPROFILE%\WhatsAppChatExporter\browser-cache`, so only the very first start downloads them. Contacts' profile photos are skipped during login to save data. If linking fails after a scan, a fresh QR appears on the same page within seconds; just scan again. Keep WhatsApp open on the phone while it syncs.
- **Network hiccups:** a sync that keeps making progress is never interrupted. If it shows no progress for 5 minutes, the app reconnects by itself without asking for a new QR.
- **Stopping the app:** close the server window or press `Ctrl+C`. This closes WhatsApp's hidden browser properly so your login stays saved.
- **Chat list speed:** the first list after linking can take a minute or two while WhatsApp syncs. After that it is cached for 2 minutes, and the ⟳ button fetches it fresh.
- This app uses the unofficial [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) library. Reading and exporting your own chats is low risk, but WhatsApp does not officially support third-party clients.
- If WhatsApp updates its website and the login stops working, run `npm install whatsapp-web.js@latest` in this folder.

## Files

```
server.js          Express + Socket.IO server (API, live QR/status, media, export jobs)
src/whatsapp.js    WhatsApp connection (QR login, groups, messages, names/numbers, media download)
src/media.js       Excel + media ZIP export (streamed download), file naming
src/excel.js       Styled Excel workbook builder (exceljs)
src/demo.js        Sample data for demo mode
src/format.js      Shared date / filter helpers
public/index.html  The app page (Tailwind utility classes, responsive down to phone width)
public/js/app.js   UI logic: QR status, group list, chat/table views, media viewer, export
public/css/app.css Built Tailwind CSS (generated — don't edit by hand)
styles/app.css     Tailwind source: theme colours, fonts, small helpers
index.html         Launcher page you can double-click
start.bat          One-click launcher
```

## Changing the design

The styling uses Tailwind CSS v4. After you edit classes in `public/` or the theme in `styles/app.css`, rebuild the CSS:

```
npm run build:css
```

Use `npm run watch:css` to rebuild automatically while you edit.
