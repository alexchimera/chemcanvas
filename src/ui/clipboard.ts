/** Copy text, falling back to a hidden text field where the async clipboard is blocked (iframes, plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Clipboard text, or null where reading it isn't allowed. */
export async function readText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    return null;
  }
}
