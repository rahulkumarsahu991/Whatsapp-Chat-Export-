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

`start-mobile.bat` runs the same app on this PC and gives it a fixed `https://….ngrok-free.dev` link that opens anywhere. Only the Google account(s) you choose can get in.

1. **First time:** double-click `start-mobile.bat`. It downloads ngrok and opens the ngrok website.
   - Make a free ngrok account.
   - Paste your **Authtoken** into the black window.
   - Paste your free **domain**, from the Domains page.
   - Type the **Gmail** address that may open the app.
2. **Every time after that:** double-click `start-mobile.bat` and open the link it prints on your phone.
   - The first visit on a device shows an ngrok notice; tap **Visit Site**.
   - Then sign in with Google.
3. To change the token, link or allowed emails, run `start-mobile.bat --setup`.

Good to know:
- The phone link works only while this PC is on and `start-mobile.bat` is running.
- The free ngrok plan allows about **1 GB of data and 20,000 requests a month**. Excel exports and chats are small, but ZIPs full of videos use that up quickly.
- Scan the QR on the PC screen. A phone can't scan its own screen.

**Demo mode:** `start-demo.bat` opens the same interface with sample groups and needs no login. Click the QR code to simulate a scan.

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

- **Privacy:** everything runs on this computer, at `127.0.0.1` only. Your chats and media are not uploaded anywhere.
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
