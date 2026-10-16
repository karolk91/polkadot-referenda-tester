import type { ReferendumStep } from '../types';
import type { Logger } from '../utils/logger';
import { describeStep } from '../utils/referendum-steps';
import { type Fork, postTestChain } from './fork';
import { runPostTest } from './post-test-runner';

export interface StepOutcome {
  main: Fork;
  referendumId?: number;
  fellowshipReferendumId?: number;
}

export interface ForkedNetwork {
  forks(): Fork[];
  runStep(step: ReferendumStep): Promise<StepOutcome>;
  teardown(cleanup: boolean): Promise<void>;
}

async function runStepPostTest(
  step: ReferendumStep,
  outcome: StepOutcome,
  position: { index: number; count: number },
  forks: Fork[],
  logger: Logger
): Promise<void> {
  if (!step.postTest) return;
  await runPostTest(
    logger,
    step.postTest.module,
    {
      main: postTestChain(outcome.main),
      chains: forks.map(postTestChain),
      verbose: logger.isVerbose(),
      step: {
        ...position,
        referendumId: outcome.referendumId,
        fellowshipReferendumId: outcome.fellowshipReferendumId,
      },
    },
    step.postTest.args
  );
}

export async function runStepsOnNetwork(
  network: ForkedNetwork,
  steps: ReferendumStep[],
  cleanup: boolean,
  logger: Logger
): Promise<void> {
  try {
    for (const [index, step] of steps.entries()) {
      if (steps.length > 1) {
        logger.section(`Step ${index + 1}/${steps.length}: ${describeStep(step)}`);
      }
      const outcome = await network.runStep(step);
      await runStepPostTest(
        step,
        outcome,
        { index: index + 1, count: steps.length },
        network.forks(),
        logger
      );
    }
  } catch (error) {
    if (!cleanup) {
      logger.failSpinner();
      logger.error('Run failed; the forks remain available for inspection', error);
    }
    throw error;
  } finally {
    await network.teardown(cleanup);
  }
}
