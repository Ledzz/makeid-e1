/** On-page console for TX/RX frames and events. */
import type { LogLevel } from '../printer/client.ts';

export class UiConsole {
  private readonly el: HTMLElement;
  private lines = 0;
  private readonly max = 3000;
  autoScroll = true;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  log(level: LogLevel, message: string): void {
    const line = document.createElement('span');
    line.className = `line ${level}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `${new Date().toLocaleTimeString(undefined, { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')} `;
    const tag = document.createElement('span');
    tag.textContent = `${level.toUpperCase().padEnd(5)} `;
    line.append(ts, tag, document.createTextNode(message), document.createTextNode('\n'));
    this.el.append(line);
    this.lines++;
    while (this.lines > this.max && this.el.firstChild) {
      this.el.removeChild(this.el.firstChild);
      this.lines--;
    }
    if (this.autoScroll) this.el.scrollTop = this.el.scrollHeight;
  }

  clear(): void {
    this.el.textContent = '';
    this.lines = 0;
  }

  text(): string {
    return this.el.textContent ?? '';
  }
}
