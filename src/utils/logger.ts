import chalk from 'chalk';
import { createSpinner } from 'nanospinner';

export class Logger {
  private verbose: boolean;
  private spinner: any = null;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  info(message: string): void {
    console.log(chalk.blue('ℹ'), message);
  }

  success(message: string): void {
    console.log(chalk.green('✓'), message);
  }

  error(message: string, error?: Error): void {
    console.log(chalk.red('✖'), message);
    if (error && this.verbose) {
      console.log(chalk.red(error.stack || error.message));
    }
  }

  warn(message: string): void {
    console.log(chalk.yellow('⚠'), message);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(chalk.gray('▸'), chalk.gray(message));
    }
  }

  startSpinner(message: string): void {
    this.spinner = createSpinner(message).start();
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  updateSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.update({ text: message });
    }
  }

  succeedSpinner(message?: string): void {
    if (this.spinner) {
      this.spinner.success({ text: message });
      this.spinner = null;
    }
  }

  failSpinner(message?: string): void {
    if (this.spinner) {
      this.spinner.error({ text: message });
      this.spinner = null;
    }
  }

  stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  section(title: string): void {
    console.log(`\n${chalk.bold.cyan(`━━━ ${title} ━━━`)}`);
  }

  table(data: Record<string, any>): void {
    console.log();
    for (const [key, value] of Object.entries(data)) {
      console.log(`  ${chalk.gray(key.padEnd(20))}: ${value}`);
    }
    console.log();
  }
}
