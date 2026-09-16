'use client';

/**
 * Frame 6.9 draws telemetry as a `.switch` in a `.settings__row`, not as
 * a button. The switch is a real checkbox inside a real form: flipping
 * it submits the same `optOut` Server Action the button did, with the
 * same value, so nothing about the write path changes — only the
 * affordance. Keyboard: the checkbox is focusable and Space toggles it,
 * which fires `change` and submits, so the control is fully reachable
 * without a pointer.
 */
export function PrivacyToggle({
  action,
  label,
  description,
  /** True when the feature is ON for this trader (i.e. NOT opted out). */
  on,
  inputId,
}: {
  action: (formData: FormData) => void;
  label: string;
  description: string;
  on: boolean;
  inputId: string;
}) {
  return (
    <form action={action} className="settings__row">
      {/* The value submitted is always the opposite of today's state —
          the same hidden field the previous button form posted. */}
      <input type="hidden" name="optOut" value={on ? 'true' : 'false'} />
      <span className="settings__label">
        <b>{label}</b>
        <span>{description}</span>
      </span>
      <label className="switch">
        <input
          id={inputId}
          type="checkbox"
          checked={on}
          aria-label={label}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        />
        <i />
      </label>
    </form>
  );
}
