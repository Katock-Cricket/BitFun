import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FORESHADOW_TERMINAL_FINISH_SETTLE_MS,
  TerminalCorrelator,
} from './TerminalCorrelator';
import {
  FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS,
  FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER,
} from './truncateTerminalOutput';

type Published = {
  type: 'terminalCommand';
  processId: string;
  cmd: string;
  output: string;
  phase: 'start' | 'end';
};

function started(sessionId: string, command: string, commandId: string) {
  return {
    type: 'CommandStarted',
    payload: { session_id: sessionId, command, command_id: commandId },
  };
}

function data(sessionId: string, chunk: string) {
  return {
    type: 'Data',
    payload: { session_id: sessionId, data: chunk },
  };
}

function finished(sessionId: string, commandId: string, exitCode = 0) {
  return {
    type: 'CommandFinished',
    payload: {
      session_id: sessionId,
      command_id: commandId,
      exit_code: exitCode,
    },
  };
}

describe('TerminalCorrelator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fabricate commands from Data-only streams (no shell integration)', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(data('s1', 'hello\r\n'));
    correlator.handleRawEvent(data('s1', 'world\r\n'));

    expect(published).toEqual([]);
    expect(correlator.activeSessionCount).toBe(0);
  });

  it('publishes start then end with joined output for SI-backed commands', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(started('s1', 'echo hi', 'c1'));
    correlator.handleRawEvent(data('s1', 'hi\n'));
    correlator.handleRawEvent(finished('s1', 'c1', 0));

    expect(published).toEqual([
      {
        type: 'terminalCommand',
        processId: 's1',
        cmd: 'echo hi',
        output: '',
        phase: 'start',
      },
      {
        type: 'terminalCommand',
        processId: 's1',
        cmd: 'echo hi',
        output: 'hi\n',
        phase: 'end',
      },
    ]);
    expect(correlator.activeSessionCount).toBe(0);
  });

  it('keeps multi-session buckets isolated', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(started('s1', 'cmd-a', 'a1'));
    correlator.handleRawEvent(started('s2', 'cmd-b', 'b1'));
    correlator.handleRawEvent(data('s1', 'out-a'));
    correlator.handleRawEvent(data('s2', 'out-b'));
    correlator.handleRawEvent(finished('s2', 'b1'));
    correlator.handleRawEvent(finished('s1', 'a1'));

    const ends = published.filter((e) => e.phase === 'end');
    expect(ends).toEqual([
      {
        type: 'terminalCommand',
        processId: 's2',
        cmd: 'cmd-b',
        output: 'out-b',
        phase: 'end',
      },
      {
        type: 'terminalCommand',
        processId: 's1',
        cmd: 'cmd-a',
        output: 'out-a',
        phase: 'end',
      },
    ]);
  });

  it('applies 64KB head/tail truncation on end output', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    const head = 'H'.repeat(FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS);
    const middle = 'M'.repeat(8_000);
    const tail = 'T'.repeat(FORESHADOW_TERMINAL_OUTPUT_HALF_CHARS);

    correlator.handleRawEvent(started('s1', 'big', 'c1'));
    correlator.handleRawEvent(data('s1', `${head}${middle}${tail}`));
    correlator.handleRawEvent(finished('s1', 'c1'));

    const end = published.find((e) => e.phase === 'end');
    expect(end?.output).toBe(
      `${head}${FORESHADOW_TERMINAL_OUTPUT_TRUNCATION_MARKER}${tail}`,
    );
  });

  it('collects late Data during finish settle window (ConPTY)', () => {
    vi.useFakeTimers();
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: FORESHADOW_TERMINAL_FINISH_SETTLE_MS,
    });

    correlator.handleRawEvent(started('s1', 'echo late', 'c1'));
    correlator.handleRawEvent(data('s1', 'first'));
    correlator.handleRawEvent(finished('s1', 'c1'));
    // Late chunk after Finished but before settle fires.
    correlator.handleRawEvent(data('s1', '-late'));

    expect(published.filter((e) => e.phase === 'end')).toHaveLength(0);

    vi.advanceTimersByTime(FORESHADOW_TERMINAL_FINISH_SETTLE_MS);

    const end = published.find((e) => e.phase === 'end');
    expect(end?.output).toBe('first-late');
  });

  it('flushes previous command when a new start arrives for the same session', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(started('s1', 'first', 'c1'));
    correlator.handleRawEvent(data('s1', 'one'));
    correlator.handleRawEvent(started('s1', 'second', 'c2'));
    correlator.handleRawEvent(data('s1', 'two'));
    correlator.handleRawEvent(finished('s1', 'c2'));

    const ends = published.filter((e) => e.phase === 'end');
    expect(ends).toEqual([
      {
        type: 'terminalCommand',
        processId: 's1',
        cmd: 'first',
        output: 'one',
        phase: 'end',
      },
      {
        type: 'terminalCommand',
        processId: 's1',
        cmd: 'second',
        output: 'two',
        phase: 'end',
      },
    ]);
  });

  it('ignores CommandFinished for a different command_id', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(started('s1', 'keep', 'c1'));
    correlator.handleRawEvent(data('s1', 'body'));
    correlator.handleRawEvent(finished('s1', 'other'));

    expect(published.filter((e) => e.phase === 'end')).toHaveLength(0);
    expect(correlator.activeSessionCount).toBe(1);

    correlator.handleRawEvent(finished('s1', 'c1'));
    expect(published.filter((e) => e.phase === 'end')[0]?.output).toBe('body');
  });

  it('flushes active buffer on SessionDestroyed', () => {
    const published: Published[] = [];
    const correlator = new TerminalCorrelator({
      publish: (event) => {
        published.push(event);
      },
      finishSettleMs: 0,
    });

    correlator.handleRawEvent(started('s1', 'dying', 'c1'));
    correlator.handleRawEvent(data('s1', 'partial'));
    correlator.handleRawEvent({
      type: 'SessionDestroyed',
      payload: { session_id: 's1' },
    });

    expect(published.filter((e) => e.phase === 'end')[0]).toEqual({
      type: 'terminalCommand',
      processId: 's1',
      cmd: 'dying',
      output: 'partial',
      phase: 'end',
    });
    expect(correlator.activeSessionCount).toBe(0);
  });
});
