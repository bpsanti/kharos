// The firstmate adapter. The core knows nothing of firstmate: this output turns an event into one line
// appended to one status file, given at launch and never guessed, in the format firstmate reads:
//   {verb} [key=kharos-<session>] [at=<epoch>]: text
// It writes nowhere else in the firstmate home, never creates the file, and in `shared` mode (the
// default) never writes done or failed: a cloud session ending is not the task ending.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clean } from '../body.ts';
import type { KharosEvent } from '../events.ts';

export type FirstmateMode = 'shared' | 'dedicated';

export interface FirstmateTarget {
  status_file: string;
  home: string;
  mode: FirstmateMode;
}

/** Validates the target before a launch uses it: the file must exist under <home>/state/ and end in .status. */
export function checkTarget(t: FirstmateTarget): string | null {
  let home: string;
  let file: string;
  try {
    home = fs.realpathSync(t.home);
    file = fs.realpathSync(t.status_file);
  } catch {
    return `the firstmate status file or home does not exist (${t.status_file}); kharos never creates it`;
  }
  if (path.dirname(file) !== path.join(home, 'state') || !file.endsWith('.status')) {
    return 'the firstmate status file must be <home>/state/<task>.status';
  }
  if (!fs.statSync(file).isFile()) return 'the firstmate status file is not a file';
  return null;
}

/** The extra footer line a dedicated launch adds: firstmate needs a session sheet on every done. */
export const DEDICATED_FOOTER =
  '- This session reports to a firstmate task of its own: add to the KHAROS-DONE object a field "sheet" with one line "FIM faltou=<cat>: <text> ;; refiz=<cat>: <text> ;; esperei=<cat>: <text>", where each <cat> is one of ambiente, brief, regra-em-prosa, gerador, decisao-em-aberto, concorrencia, main-vermelha, ferramenta, build-frio, ci, nada.';

const SHEET_RE = /^FIM faltou=[a-z-]+: .+ ;; refiz=[a-z-]+: .+ ;; esperei=[a-z-]+: .+$/;

export function statusLine(ev: KharosEvent, mode: FirstmateMode, now: number, sheet: string | null): string | null {
  const at = `[at=${Math.floor(now / 1000)}]`;
  const key = `[key=kharos-${ev.session}]`;
  const kind = ev.event.slice('session.'.length);
  const where = ev.url ? ` ${ev.url}` : '';
  const pr = ev.pr ? ` PR ${ev.pr}` : ' no PR';
  const text = (s: string) => clean(s, 400);
  switch (kind) {
    case 'opened':
      return `working ${at}: ${text(`kharos ${ev.session} cloud session opened (${ev.title})`)}${where}`;
    case 'back':
      return `resolved ${key} ${at}: ${text(`kharos ${ev.session} is back to ${ev.state.replace(/_/g, ' ')}`)}`;
    case 'waiting_answer':
      return `needs-decision ${key} ${at}: ${text(`kharos ${ev.session} asks: ${ev.question ?? ev.reason}`)}${where}`;
    case 'finished': {
      if (mode === 'dedicated') {
        if (!sheet || !SHEET_RE.test(sheet)) return `blocked ${key} ${at}: ${text(`kharos ${ev.session} finished without the session sheet`)}${pr}${where}`;
        return `done ${at}: ${text(`kharos ${ev.session} finished: ${ev.summary ?? 'no summary'}`)}${pr} ${text(sheet)}`;
      }
      if (ev.open_notice) return `resolved ${key} ${at}: ${text(`kharos ${ev.session} finished`)}${pr}`;
      return `note ${at}: ${text(`kharos ${ev.session} finished`)}${pr}`;
    }
    case 'failed':
    case 'ended_unmarked':
      if (mode === 'dedicated') return `failed ${at}: ${text(`kharos ${ev.session} ${ev.reason}`)}${where}`;
      return `blocked ${key} ${at}: ${text(`kharos ${ev.session} ${ev.reason}`)}${where}`;
    default:
      return `blocked ${key} ${at}: ${text(`kharos ${ev.session} ${kind.replace(/_/g, ' ')}: ${ev.reason}`)}${where}`;
  }
}

/** Appends the line and tells the fleet ledger, the way firstmate's own workers do; a ledger failure is ignored. */
export function writeStatus(t: FirstmateTarget, ev: KharosEvent, now: number, sheet: string | null): void {
  const problem = checkTarget(t);
  if (problem) throw new Error(problem);
  const line = statusLine(ev, t.mode, now, sheet);
  if (!line) return;
  fs.appendFileSync(t.status_file, line + '\n');
  const ledger = path.join(t.home, 'config', 'fleet-ledger');
  if (fs.existsSync(ledger)) {
    spawnSync(path.join(t.home, 'bin', 'fm-fleet-ledger.sh'), ['appended', path.join(t.home, 'config'), t.status_file], { stdio: 'ignore', timeout: 10_000 });
  }
}
