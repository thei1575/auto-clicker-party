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

You can drag the panel by its title bar. Its position is remembered on future pages. Use the `−` button to minimize it to a small title bar and `+` to restore it.

1. On the first screen, choose **Local**, **Host**, or **Join**.
2. In **Local** mode, select a target button and control the clicker only in this browser.
3. While selecting, only clickable elements can be picked. Hovering highlights what a click would actually activate in amber — hover the label inside a button and the button itself is selected — and outlines anything unclickable in dashed red. Buttons, links, form controls, `role` widgets, focusable elements, and elements showing a pointer cursor all qualify; plain text and disabled controls do not. A page that attaches a click handler without any of those signals cannot be detected, so hold **Alt** while clicking to select an element anyway. Alt also selects exactly the element under the cursor rather than its enclosing clickable region.
4. In **Host** mode, select the target button, share the generated party code, then choose the timing mode and the click count. Pressing **Start** begins a fixed five-second synchronized countdown, shown in every panel, before all browsers click together. Stop is synchronized too.
5. In **Join** mode, enter the code from the host. Joined browsers are read-only: the target selector and the settings are hidden, and the host's choices are applied automatically. A spinner traces the button the host picked, so a joined browser can see what it is about to click. It follows the button as the page reflows or re-renders, and hides while the button is scrolled out of view.
6. Every browser shows its own browser ID: hosts in the **Party code** card, joined browsers in the **Joined party** card, and both in the title bar so the ID stays readable while the panel is minimized. The host names each joined browser by that same ID.
7. The host dashboard keeps the party code, click progress, **Start**, **Stop**, and the status line in view at all times. Joined browsers appear in a compact two-column list with a status dot, state, progress, click rate, and measured clock difference; that list scrolls on its own, so the panel never grows past the window whether 2 or 20 browsers are connected.

## Reloads and reconnections

Each browser stores its party role, party code, and browser ID, so reloading a page rejoins the same party by itself. A host reloads straight back into its own room with every joined browser still listed, and a joined browser reconnects without the code being typed again. Because reconnections are keyed on the stored browser ID, a browser resumes its existing place in the party rather than appearing twice.

Interruptions are retried automatically. For three minutes after a reload or a dropped connection, a browser keeps its party code and waits — for the relay to answer again, or for a host that is still reloading to reopen the room — and only then asks for the code again. The host also remembers its selected button locally, so it restores the target even after the relay has been restarted. Panels show the current connection state, including `Reconnecting…`, `Party is not open yet. Waiting for the host…`, and, on the host, how many browsers are reconnecting.

Before starting, each browser performs a three-step clock synchronization with the relay (request, timestamp response, acknowledgement), then refreshes it while connected. The host sends one seeded run plan, so every browser starts on the same absolute millisecond. Each browser mixes its own browser ID into that seed to derive its delay sequence, and refuses a run plan from a newer script version rather than clicking to a schedule it cannot reproduce.

## Timing

The **Timing** dropdown chooses between two modes.

**Manual** keeps an even rhythm: the base delay plus or minus the randomization, drawn uniformly, with both boxes yours to set. That is a flat, symmetric distribution, which no person produces.

**Human-like** owns the timing itself. The delay and randomization boxes disappear, leaving only the click count to choose. Three things change. Intervals become right-skewed rather than symmetric, so gaps slower than the nominal pace are more common than faster ones. The tempo drifts, speeding up and sagging over stretches of several seconds rather than resetting on every click. And clicking arrives in bursts rather than an unbroken stream: 10 to 60 clicks at a time, about 32 on average, separated by breathers of roughly a quarter of a second, with a longer pause of a second or so about every twenty-fifth burst. A long session slows by up to 5 per cent as fatigue sets in.

Its pace is calibrated against a measured spam-clicker: 7 clicks per second nominal, reaching about 11 for a ten-second sprint. The tempo walk is shaped to match both figures -- how fast a sprint gets, and how long one holds before pulling back -- and the pace inside a burst is compressed to pay for the pauses, so the average lands on the nominal rate instead of below it. The panel prints both numbers under the dropdown.

The host's choice applies to the whole party, and every browser draws its own rhythm from it. The party still begins on the same absolute millisecond, but browsers pause and resume independently afterwards, because a room full of browsers resting in lockstep would itself look coordinated. This changes timing only; it does not change how a click is dispatched.

> Joined browsers should be on matching pages with the same button layout. The host's selected CSS selector must exist in every joined browser for synchronized clicking to work.

The server keeps parties only in memory. Restarting it disconnects every party. The party code is the access key, so share it only with people who should be able to join. This is a coordination relay, not authentication or end-to-end encryption.

## Monitoring

The relay exposes Prometheus metrics at `/metrics`, including active rooms, connected browsers, scheduled countdowns, accepted connections, and host commands. A ready-to-use Netdata Go.d collector job is included at [`party-server/netdata-prometheus.conf`](./party-server/netdata-prometheus.conf).
