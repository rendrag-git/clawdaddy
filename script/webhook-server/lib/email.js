import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'noreply@openclaw.dev';

async function send(to, subject, text) {
  await resend.emails.send({ from: FROM, to, subject, text });
}

export async function provisioning_started(email) {
  await send(email, 'Setting up your OpenClaw assistant...', `Hi there,

Thanks for subscribing to OpenClaw managed hosting!

We're spinning up your personal AI assistant right now. This usually takes a few minutes.

You'll receive another email with your connection details as soon as everything is ready.

-- OpenClaw`);
}

export async function provisioning_complete(email, { ip, vnc_password, region }) {
  await send(email, 'Your OpenClaw assistant is ready!', `Hi there,

Your OpenClaw assistant is live and ready to use!

## Connection Details

  Server IP:     ${ip}
  VNC Password:  ${vnc_password}
  Region:        ${region}

## Quick Start

1. Open a VNC client (we recommend TigerVNC or RealVNC)
2. Connect to ${ip}:5901
3. Enter your VNC password when prompted
4. Your AI assistant is running and ready to go

If you have any questions, reply to this email or reach out on Discord.

-- OpenClaw`);
}

export async function provisioning_started_managed(email) {
  await send(email, 'Setting up your OpenClaw assistant...', `Hi there,

Thanks for subscribing to OpenClaw Fully Managed hosting!

We're spinning up your personal AI assistant right now. This usually takes a few minutes. Your plan is fully managed — no API key needed, usage is included.

You'll receive another email with your connection details as soon as everything is ready.

-- OpenClaw`);
}

export async function provisioning_complete_managed(email, { ip, vnc_password, region }) {
  await send(email, 'Your OpenClaw assistant is ready!', `Hi there,

Your OpenClaw Fully Managed assistant is live and ready to use!

Your API usage is included — no API key needed. Everything is pre-configured and ready to go.

## Connection Details

  Server IP:     ${ip}
  VNC Password:  ${vnc_password}
  Region:        ${region}

## Quick Start

1. Open a VNC client (we recommend TigerVNC or RealVNC)
2. Connect to ${ip}:5901
3. Enter your VNC password when prompted
4. Your AI assistant is running and ready to go

If you have any questions, reply to this email or reach out on Discord.

-- OpenClaw`);
}

export async function provisioning_failed(email) {
  await send(email, 'We\'re setting things up', `Hi there,

Your OpenClaw assistant needs a bit more time to get ready. Our team has been notified and we'll have everything running for you within 1 hour.

We'll send you a follow-up email with your connection details as soon as it's ready.

-- OpenClaw`);
}

export async function subscription_canceled(email, destroy_date) {
  const formatted = new Date(destroy_date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  await send(email, 'Your OpenClaw subscription was canceled', `Hi there,

We're sorry to see you go. Your OpenClaw subscription has been canceled.

## Important: Data Export Window

Your instance and all its data will remain available until ${formatted} (7 days from now). After that date, your instance will be permanently deleted.

If you need to export any data, please connect via VNC and save anything you need before that date.

To resubscribe at any time, visit https://openclaw.dev/pricing.

-- OpenClaw`);
}

export async function payment_failed_retry(email) {
  await send(email, 'Payment failed - we\'ll retry automatically', `Hi there,

We weren't able to process your latest payment for OpenClaw managed hosting.

Don't worry -- we'll retry automatically over the next few days. Please make sure your payment method is up to date in your Stripe billing portal.

Your instance remains active and unaffected.

-- OpenClaw`);
}

export async function payment_failed_suspended(email) {
  await send(email, 'Instance suspended due to payment failure', `Hi there,

After multiple attempts, we were unable to process your payment for OpenClaw managed hosting. Your instance has been suspended.

Your data is still safe -- update your payment method and reach out to us to reactivate your instance.

-- OpenClaw`);
}
