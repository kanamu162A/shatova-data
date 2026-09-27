import nodemailer from 'nodemailer';
import { env } from '../env/env.js';

let transporter = null;

if (env.hasEmail) {
  transporter = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: false,
    auth: {
      user: env.EMAIL_USER,
      pass: env.EMAIL_PASS,
    },
  });

  transporter.verify((err) => {
    if (err) console.warn('Email transport error:', err.message);
    else console.log('Email transport ready');
  });
}

export async function sendPasswordResetEmail({ to, name, resetLink }) {
  if (!transporter) {
    console.warn('Email not configured - reset link logged below');
    console.log(`\nRESET LINK for ${to}:\n${resetLink}\n`);
    return { ok: true, dev: true };
  }

  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:32px;background:#f8fafc;border-radius:16px;">
    <h1 style="text-align:center;color:#1e1b4b;font-style:italic;margin:0 0 24px;">Shatova</h1>
    <div style="background:#fff;border-radius:12px;padding:32px;">
      <h2 style="color:#0f172a;margin:0 0 16px;">Reset your password</h2>
      <p style="color:#475569;line-height:1.6;">Hi ${name || 'there'},</p>
      <p style="color:#475569;line-height:1.6;">
        Click the button below to set a new Shatova password.
        This link expires in 15 minutes.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${resetLink}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
          Reset Password
        </a>
      </div>
      <p style="color:#94a3b8;font-size:13px;">
        If you didn't request this, ignore this email. Your password won't change.
      </p>
    </div>
  </div>`;

  try {
    await transporter.sendMail({
      from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_USER}>`,
      to,
      subject: 'Reset your Shatova password',
      html,
    });
    return { ok: true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { ok: false, error: 'EMAIL_SEND_FAILED' };
  }
}