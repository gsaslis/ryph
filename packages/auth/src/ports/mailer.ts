// Outbound mail, as the auth core sends it: one message at a time, plain text. Null in a
// deployment with no mailer — every link a mail would carry is then handed to an admin instead.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Throws when the message could not be handed to the transport. */
  send(mail: Mail): Promise<void>;
}
