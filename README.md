# Auto Clicker Party

This contains a Tampermonkey userscript and a deliberately small party relay.

## Run the relay

Deploy the `party-server` folder to any Node.js host that supports long-lived WebSocket connections. Set its public port with `PORT` if your host requires it.

```sh
cd party-server
npm install
npm start
```

For local testing, the relay is at `ws://localhost:8080`; its health check is `http://localhost:8080/health`. For a public site behind TLS, use a reverse proxy that upgrades WebSocket connections and enter its `wss://...` URL in the script. Never use `ws://` from an HTTPS page except with a local-development server: browsers block insecure WebSockets there.

The included `Dockerfile` can also be used where Docker is available. Keep the container bound to localhost and let your TLS proxy publish it:

```sh
docker build -t auto-clicker-party .
docker run -d --name auto-clicker-party --restart unless-stopped -p 127.0.0.1:8787:8080 auto-clicker-party
```

## Install the Tampermonkey script

1. Install the [Tampermonkey browser extension](https://www.tampermonkey.net/) and pin it to your browser toolbar.
2. Click [Install Auto Clicker Party](https://raw.githubusercontent.com/thei1575/auto-clicker-party/main/Universal%20Button%20Auto%20Clicker%20Party.user.js), then choose **Install** in Tampermonkey.
3. Open or reload the page containing the button to click. The panel appears in the top-right corner. If it was hidden, open Tampermonkey's extension menu and select **Show Auto Clicker**.

The script checks the public GitHub source for newer versions automatically. Tampermonkey will offer to install an update when one is available; you can also use **Check for userscript updates** from its extension menu.

The script already uses the public relay at `https://clicker.oz1tnj.dk`; no server address needs to be entered. It uses Tampermonkey's permitted HTTPS connection for every browser, so it also works on Chromium pages that block external WebSockets. No browser setting or extra configuration is required.

## Use the party controls

You can drag the panel by its title bar. Use the `−` button to minimize it to a small title bar and `+` to restore it.

1. On the first screen, choose **Local**, **Host**, or **Join**.
2. In **Local** mode, select a target button and control the clicker only in this browser.
3. In **Host** mode, select the target button, share the generated party code, then set the delay, randomization, and click count. Start and Stop are synchronized to all joined browsers.
4. In **Join** mode, enter the code from the host. Joined browsers are read-only: the host's target selector and settings are applied automatically.
5. The host dashboard shows every joined browser's readiness, running state, and click progress.

> Joined browsers should be on matching pages with the same button layout. The host's selected CSS selector must exist in every joined browser for synchronized clicking to work.

The server keeps parties only in memory. Restarting it disconnects every party. The party code is the access key, so share it only with people who should be able to join. This is a coordination relay, not authentication or end-to-end encryption.
