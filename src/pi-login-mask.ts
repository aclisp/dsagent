import { LoginDialogComponent } from "@earendil-works/pi-coding-agent";

const PATCH_MARKER = Symbol.for("dscode.login-secret-mask");
const MASK = "•";

interface RuntimeInput {
  value: string;
  cursor: number;
  render(width: number): string[];
}

interface RuntimeLoginDialog {
  input: RuntimeInput;
  dscodeSecretPrompt?: boolean;
}

interface RuntimeLoginPrototype {
  [PATCH_MARKER]?: boolean;
  showPrompt(message: string, placeholder?: string): Promise<string>;
  replaceInputWithSubmittedText(value: string): void;
}

export function installPiLoginSecretMask(): void {
  const prototype = LoginDialogComponent.prototype as unknown as RuntimeLoginPrototype;
  if (prototype[PATCH_MARKER]) return;
  prototype[PATCH_MARKER] = true;

  const originalShowPrompt = prototype.showPrompt;
  const originalReplace = prototype.replaceInputWithSubmittedText;

  prototype.showPrompt = function (message: string, placeholder?: string): Promise<string> {
    const dialog = this as unknown as RuntimeLoginDialog;
    dialog.dscodeSecretPrompt = /api[\s_-]*key|密钥/i.test(message);
    if (dialog.dscodeSecretPrompt) maskRuntimeInput(dialog.input);
    return originalShowPrompt.call(this, message, placeholder);
  };

  prototype.replaceInputWithSubmittedText = function (value: string): void {
    const dialog = this as unknown as RuntimeLoginDialog;
    const displayValue = dialog.dscodeSecretPrompt ? MASK.repeat(Math.min(12, Math.max(8, value.length))) : value;
    originalReplace.call(this, displayValue);
    dialog.dscodeSecretPrompt = false;
  };
}

function maskRuntimeInput(input: RuntimeInput): void {
  const runtime = input as RuntimeInput & { dscodeMaskInstalled?: boolean };
  if (runtime.dscodeMaskInstalled) return;
  runtime.dscodeMaskInstalled = true;
  const originalRender = input.render;
  input.render = function (width: number): string[] {
    const value = input.value;
    const cursor = input.cursor;
    input.value = MASK.repeat(value.length);
    input.cursor = Math.min(cursor, input.value.length);
    try {
      return originalRender.call(input, width);
    } finally {
      input.value = value;
      input.cursor = cursor;
    }
  };
}
