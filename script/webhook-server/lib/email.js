import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZEPTO_KEY = process.env.ZEPTOMAIL_API_KEY ||
  (() => { try { return readFileSync(resolve(__dirname, "../../../.secrets/zeptomail-key"), "utf8").trim(); } catch { return null; } })();
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@clawdaddy.sh";
const FROM_NAME = process.env.FROM_NAME || "ClawDaddy";

async function send(to, subject, text) {
  if (!ZEPTO_KEY) {
    console.log(`[EMAIL-STUB] To: ${to} | Subject: ${subject}`);
    return;
  }
  const body = {
    from: { address: FROM_EMAIL, name: FROM_NAME },
    to: [{ email_address: { address: to } }],
    subject,
    textbody: text,
  };
  const res = await fetch("https://api.zeptomail.com/v1.1/email", {
    method: "POST",
    headers: {
      "Authorization": ZEPTO_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ZeptoMail error (${res.status}): ${err}`);
  }
  console.log(`[EMAIL] Sent to ${to}: ${subject}`);
}

export async function provisioning_started(email) {
  await send(email, "Setting up your ClawDaddy assistant...",
    "Hi there,\n\nThanks for subscribing to ClawDaddy!\n\nWe're spinning up your personal AI assistant right now. This usually takes a few minutes.\n\nYou'll receive another email with your connection details as soon as everything is ready.\n\n-- ClawDaddy");
}

export async function provisioning_complete(email, { username, portalToken, region }) {
  await send(email, "Your ClawDaddy assistant is ready!",
    `Hi there,\n\nYour ClawDaddy assistant is live and ready to use!\n\nYour Portal:\n\n  https://${username}.clawdaddy.sh/portal/\n\nPassword: ${portalToken}\n\nRegion: ${region}\n\nBookmark this link and keep your password secure. You can access your assistant anytime from any browser.\n\nIf you have any questions, reply to this email or reach out on Discord.\n\n-- ClawDaddy`);
}

export async function provisioning_started_managed(email) {
  await send(email, "Setting up your ClawDaddy assistant...",
    "Hi there,\n\nThanks for subscribing to ClawDaddy Fully Managed hosting!\n\nWe're spinning up your personal AI assistant right now. This usually takes a few minutes. Your plan is fully managed — no API key needed, usage is included.\n\nYou'll receive another email with your connection details as soon as everything is ready.\n\n-- ClawDaddy");
}

export async function onboarding_welcome(email, checkout_session_id) {
  const onboarding_url = `https://clawdaddy.sh/onboarding/?session_id=${encodeURIComponent(checkout_session_id)}`;
  await send(email, "Welcome to ClawDaddy — set up your assistant",
    `Hi there,\n\nThanks for subscribing to ClawDaddy!\n\nClick the link below to set up your personal AI assistant. You'll choose a name, take a quick personality quiz, and we'll configure everything for you.\n\nSet up your assistant:\n${onboarding_url}\n\nThis link doesn't expire — you can come back to it anytime.\n\nIf you have any questions, reply to this email.\n\n-- ClawDaddy`);
}

export async function provisioning_complete_managed(email, { username, portalToken, region }) {
  await send(email, "Your ClawDaddy assistant is ready!",
    `Hi there,\n\nYour ClawDaddy Fully Managed assistant is live and ready to use!\n\nYour API usage is included — no API key needed. Everything is pre-configured and ready to go.\n\nYour Portal:\n\n  https://${username}.clawdaddy.sh/portal/\n\nPassword: ${portalToken}\n\nRegion: ${region}\n\nBookmark this link and keep your password secure. You can access your assistant anytime from any browser.\n\nIf you have any questions, reply to this email or reach out on Discord.\n\n-- ClawDaddy`);
}

export async function provisioning_failed(email) {
  await send(email, "We're setting things up",
    "Hi there,\n\nYour ClawDaddy assistant needs a bit more time to get ready. Our team has been notified and we'll have everything running for you within 1 hour.\n\nWe'll send you a follow-up email with your connection details as soon as it's ready.\n\n-- ClawDaddy");
}

export async function subscription_canceled(email, destroy_date) {
  const formatted = new Date(destroy_date).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });
  await send(email, "Your ClawDaddy subscription was canceled",
    `Hi there,\n\nWe're sorry to see you go. Your ClawDaddy subscription has been canceled.\n\nImportant: Data Export Window\n\nYour instance and all its data will remain available until ${formatted} (7 days from now). After that date, your instance will be permanently deleted.\n\nIf you need to export any data, please log in to your portal and save anything you need before that date.\n\nTo resubscribe at any time, visit https://clawdaddy.sh\n\n-- ClawDaddy`);
}

export async function payment_failed_retry(email) {
  await send(email, "Payment failed - we'll retry automatically",
    "Hi there,\n\nWe weren't able to process your latest payment for ClawDaddy.\n\nDon't worry -- we'll retry automatically over the next few days. Please make sure your payment method is up to date in your Stripe billing portal.\n\nYour instance remains active and unaffected.\n\n-- ClawDaddy");
}

export async function payment_failed_suspended(email) {
  await send(email, "Instance suspended due to payment failure",
    "Hi there,\n\nAfter multiple attempts, we were unable to process your payment for ClawDaddy. Your instance has been suspended.\n\nYour data is still safe -- update your payment method and reach out to us to reactivate your instance.\n\n-- ClawDaddy");
}
