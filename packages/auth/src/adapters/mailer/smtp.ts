// `Mailer` over SMTP via nodemailer — the one transport every provider offers. The package
// ships no types this side needs beyond the two calls below, so they are named here rather than
// pulled in with a whole Node typing surface.

// @ts-expect-error: nodemailer ships no declaration file; the cast below types what is used.
import nodemailer from "nodemailer";
import type { Mail, Mailer } from "../../ports/mailer.ts";

interface Transport {
  sendMail(mail: Mail & { from: string }): Promise<unknown>;
}

const { createTransport } = nodemailer as unknown as {
  createTransport(url: string): Transport;
};

export interface SmtpMailerOptions {
  /** `smtp://user:pass@host:587` or `smtps://…` — nodemailer's connection URL shape. */
  url: string;
  /** The `From` header, e.g. `ryph <ryph@example.com>`. */
  from: string;
}

export function smtpMailer(opts: SmtpMailerOptions): Mailer {
  const transport = createTransport(opts.url);
  return {
    async send(mail) {
      await transport.sendMail({ from: opts.from, ...mail });
    },
  };
}
