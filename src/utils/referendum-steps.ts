import * as path from 'path';
import type { PreCall, ReferendumSource, ReferendumStep } from '../types';

export function governanceSource(step: ReferendumStep): ReferendumSource | undefined {
  return 'governance' in step.referenda ? step.referenda.governance : undefined;
}

export function fellowshipSource(step: ReferendumStep): ReferendumSource | undefined {
  return 'fellowship' in step.referenda ? step.referenda.fellowship : undefined;
}

export function preCallOf(step: ReferendumStep): PreCall | undefined {
  return 'preCall' in step.referenda ? step.referenda.preCall : undefined;
}

export function referendumCreations(steps: ReferendumStep[]): {
  governance: boolean;
  fellowship: boolean;
} {
  return {
    governance: steps.some((step) => governanceSource(step)?.kind === 'create'),
    fellowship: steps.some((step) => fellowshipSource(step)?.kind === 'create'),
  };
}

function sourceDescription(source: ReferendumSource | undefined, description: string): string[] {
  if (!source) return [];
  return [
    source.kind === 'existing'
      ? `${description} #${source.id}`
      : `create ${description} referendum`,
  ];
}

export function describeStep(step: ReferendumStep): string {
  return [
    ...sourceDescription(fellowshipSource(step), 'fellowship'),
    ...sourceDescription(governanceSource(step), 'governance'),
    ...(step.postTest ? [`post-test ${path.basename(step.postTest.module)}`] : []),
  ].join(' + ');
}
