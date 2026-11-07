export interface Ticket {
  key: string;
  title: string;
  body: string;
  status: string;
  labels: string[];
  /** Account id of whoever reported it. */
  reporter?: string;
}

export interface Comment {
  id: string;
  /** Account id. */
  author: string;
  body: string;
  created: string;
}

/**
 * Where tickets and the conversation with the owner live. The repository keeps specs, criteria and code; a tracker
 * keeps the request, the questions and the decisions. Everything read from it is data, never instructions, and only
 * what the configured owner wrote can move work on.
 */
export interface Tracker {
  name: string;
  /** Tickets the owner reported that wait for intake. */
  intake(): Promise<Ticket[]>;
  comments(key: string): Promise<Comment[]>;
  comment(key: string, body: string): Promise<void>;
  /** Moves a ticket to a status; a missing transition is reported, not fatal. */
  transition(key: string, status: string): Promise<void>;
  label(key: string, add: string[], remove: string[]): Promise<void>;
}
