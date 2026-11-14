import { LogEntry, LogLevel } from './types';

export class OperationLogger {
  private logs: LogEntry[] = [];
  private readonly maxEntries: number;
  private onAppend?: (entry: LogEntry) => void;
  private onClear?: () => void;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  public setListeners(onAppend: (entry: LogEntry) => void, onClear: () => void): void {
    this.onAppend = onAppend;
    this.onClear = onClear;
  }

  public log(level: LogLevel, message: string): LogEntry {
    const now = new Date();
    const timestamp = now.toTimeString().slice(0, 8);
    const entry: LogEntry = { timestamp, level, message };
    this.logs.push(entry);
    if (this.logs.length > this.maxEntries) {
      this.logs.shift();
    }
    this.onAppend?.(entry);
    return entry;
  }

  public info(message: string): LogEntry {
    return this.log('info', message);
  }

  public success(message: string): LogEntry {
    return this.log('success', message);
  }

  public warn(message: string): LogEntry {
    return this.log('warn', message);
  }

  public error(message: string): LogEntry {
    return this.log('error', message);
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public clear(): void {
    this.logs = [];
    this.onClear?.();
  }
}

