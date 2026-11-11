# QR Wi-Fi Vouchers

staff taps **generate voucher**, qr shows up, customer scans it, gets wifi for 3 hours. orders again? make a new one. basically Piso WiFi / JuanFi but the "coin" is a qr that staff hands over

no `npm install` needed. only uses what comes with Node (22 or newer)

## try it rn (demo mode, no router needed)

```
node manage.js add-staff maria      # asks for a password
node server.js
```

open the address it prints (like `http://192.168.1.20:3000`) and log in

in demo mode the app pretends to be the router. generate a voucher, scan the qr with a phone on the same wifi (or just open the link on another device). you should see "You're connected". scan the same code on a 2nd device and it gets refused, same as a real one-device voucher

run the tests w/ `node --test`

## how it works

1. staff logs in, presses **generate voucher**
2. app makes a hotspot user on the router (random 8 char code, `limit-uptime` 3h, 1 device at a time) thru the RouterOS v7 REST API
3. the qr is just a login link: `http://<router>/login?username=CODE&password=CODE`
4. customer joins the cafe guest wifi, scans the qr, router logs them in
5. the 3 hours start at the **first connection**, not when the voucher was made. unused ones expire after 12 hrs. the app checks the router every 10 secs, cleans up finished users and keeps a history list. staff can **revoke** any live voucher

qr image is drawn in the browser (`public/qr.js`, wrote it for this project, checked against a real qr decoder) so theres nothing to install

## staff accounts

```
node manage.js add-staff <name>
node manage.js set-password <name>
node manage.js remove-staff <name>
node manage.js list-staff
```

works while the server is running. remove someone and they get logged out right away

stuck on the password prompt? skip it:
- windows cmd: `set QRWIFI_PASSWORD=cafe-demo-123` then `node manage.js add-staff maria`
- mac/linux: `QRWIFI_PASSWORD=cafe-demo-123 node manage.js add-staff maria`

## settings

copy `config.example.json` to `config.json` and edit. no config = demo mode w/ defaults. stuff u might wanna change: `cafeName`, `wifiName`, `voucher.durationOptionsMinutes`, `voucher.unusedExpiryHours`, `port`

## moving to a real MikroTik

heads up: this part is written from the RouterOS v7 REST API docs but **not tested on real hardware or CHR yet**, i had nothing to test on. try it on a spare router or CHR first before the cafe depends on it, and expect to fix small stuff

needs RouterOS 7.1 or newer. physical setup: PLDT modem LAN port to the MikroTik `ether1` (WAN), customers join the MikroTik guest ssid, and the computer running this app has to be on the same network as the MikroTik

on the router (Terminal in WinBox), after running `/ip hotspot setup` on the guest interface:

```
# customers' profile: one device per code, speed cap per customer
/ip hotspot user profile add name=qrwifi shared-users=1 rate-limit=5M/5M

# allow login by plain link (needed for the qr)
/ip hotspot profile set [find] login-by=http-pap

# an account just for this app
/user group add name=qrwifi-api policy=read,write,api,rest-api,test
/user add name=qrwifi-api group=qrwifi-api password=CHANGE-ME

# REST API (use www-ssl with a certificate if u can)
/ip service set www disabled=no
```

then in `config.json`:

```
"router": {
  "mode": "routeros",
  "url": "http://192.168.88.1",
  "username": "qrwifi-api",
  "password": "CHANGE-ME",
  "profile": "qrwifi",
  "loginUrl": "http://192.168.88.1/login"
}
```

restart the app. the staff page header tells u if the router is reachable. dont put the router api on the internet, only allow it from the cafe network (`/ip service set www address=192.168.88.0/24`)

## good to know

- the qr only logs in, the phone has to be on the guest wifi already. put a little sign at the counter: "join MyCafe Guest WiFi, then scan the qr"
- if the app's computer is off, people already connected stay connected and the router still cuts them off on time. staff just cant make new vouchers
- `data/` has the vouchers and staff accounts. back it up if u care about history
- no https here so keep it on the cafe network only, dont expose it to the internet