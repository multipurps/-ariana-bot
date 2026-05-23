"use strict";
/**
 * Run this ONCE locally to generate your TELEGRAM_SESSION string.
 * 
 * Steps:
 *   1. npm install telegram input
 *   2. node gen-session.js
 *   3. Enter your phone number, Telegram code, 2FA password if any
 *   4. Copy the printed session string
 *   5. Paste it as TELEGRAM_SESSION env var on Render
 *   6. Never run this again — the session persists forever
 */

const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const input              = require("input");

const API_ID   = parseInt(process.env.TELEGRAM_API_ID  || "");
const API_HASH =           process.env.TELEGRAM_API_HASH || "";

if (!API_ID || !API_HASH) {
  console.error("❌  Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.");
  console.error("    Get them from https://my.telegram.org → API development tools");
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(
    new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () => await input.text("📱 Phone number (with country code, e.g. +2348012345678): "),
    password:    async () => await input.text("🔒 2FA password (press Enter if none): "),
    phoneCode:   async () => await input.text("📨 Code Telegram just sent you: "),
    onError:     err  => console.error("Error:", err),
  });

  const session = client.session.save();
  console.log("\n✅ SUCCESS — copy everything between the lines:\n");
  console.log("─".repeat(60));
  console.log(session);
  console.log("─".repeat(60));
  console.log("\nPaste that as TELEGRAM_SESSION in your Render environment variables.\n");

  await client.disconnect();
  process.exit(0);
})();
