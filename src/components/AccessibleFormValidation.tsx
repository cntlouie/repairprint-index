"use client";

import { useEffect, useRef, useState } from "react";

type ValidatableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

type ValidationError = Readonly<{
  fieldId: string;
  label: string;
  message: string;
}>;

type OriginalAccessibilityState = Readonly<{
  ariaDescribedBy: string | null;
  ariaInvalid: string | null;
}>;

const CONTROL_SELECTOR = 'input:not([type="hidden"]), select, textarea';

/**
 * Adds an accessible summary to native HTML constraint validation. The form's
 * action, method and constraints remain ordinary HTML, so the browser and the
 * server remain authoritative when JavaScript is unavailable or bypassed.
 */
export function AccessibleFormValidation() {
  const summaryRef = useRef<HTMLDivElement>(null);
  const originalsRef = useRef(new Map<ValidatableControl, OriginalAccessibilityState>());
  const focusSummaryRef = useRef(false);
  const [errors, setErrors] = useState<readonly ValidationError[]>([]);

  useEffect(() => {
    const summary = summaryRef.current;
    const form = summary?.closest("form");
    if (!summary || !form) return;

    const originals = originalsRef.current;
    let validationAttempted = false;
    let refreshQueued = false;
    summary.dataset.validationReady = "true";

    const controls = () => Array.from(form.querySelectorAll<ValidatableControl>(CONTROL_SELECTOR))
      .filter((control) => control.willValidate && !control.closest('[aria-hidden="true"]'));

    const restoreControl = (control: ValidatableControl) => {
      const original = originals.get(control);
      if (!original) return;
      restoreAttribute(control, "aria-describedby", original.ariaDescribedBy);
      restoreAttribute(control, "aria-invalid", original.ariaInvalid);
      originals.delete(control);
    };

    const refreshErrors = (moveFocus: boolean) => {
      refreshQueued = false;
      const nextErrors: ValidationError[] = [];
      const invalidControls = new Set<ValidatableControl>();

      for (const control of controls()) {
        if (control.validity.valid || !control.id) continue;
        invalidControls.add(control);
        if (!originals.has(control)) {
          originals.set(control, {
            ariaDescribedBy: control.getAttribute("aria-describedby"),
            ariaInvalid: control.getAttribute("aria-invalid"),
          });
        }

        const label = validationLabel(control);
        const errorId = validationErrorId(control.id);
        const describedBy = new Set((control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean));
        describedBy.add(errorId);
        control.setAttribute("aria-describedby", [...describedBy].join(" "));
        control.setAttribute("aria-invalid", "true");
        nextErrors.push({ fieldId: control.id, label, message: validationMessage(control, label) });
      }

      for (const control of originals.keys()) {
        if (!invalidControls.has(control)) restoreControl(control);
      }

      focusSummaryRef.current = moveFocus && nextErrors.length > 0;
      setErrors(nextErrors);
    };

    const queueRefresh = (moveFocus: boolean) => {
      focusSummaryRef.current ||= moveFocus;
      if (refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => refreshErrors(focusSummaryRef.current));
    };

    const handleInvalid = (event: Event) => {
      const control = asValidatableControl(event.target);
      if (!control || !form.contains(control) || !control.matches(CONTROL_SELECTOR)) return;
      event.preventDefault();
      validationAttempted = true;
      queueRefresh(true);
    };

    const handleValueChange = () => {
      if (validationAttempted) queueRefresh(false);
    };

    const handleReset = () => {
      validationAttempted = false;
      focusSummaryRef.current = false;
      for (const control of originals.keys()) restoreControl(control);
      setErrors([]);
    };

    form.addEventListener("invalid", handleInvalid, true);
    form.addEventListener("input", handleValueChange);
    form.addEventListener("change", handleValueChange);
    form.addEventListener("reset", handleReset);
    return () => {
      form.removeEventListener("invalid", handleInvalid, true);
      form.removeEventListener("input", handleValueChange);
      form.removeEventListener("change", handleValueChange);
      form.removeEventListener("reset", handleReset);
      delete summary.dataset.validationReady;
      for (const control of originals.keys()) restoreControl(control);
    };
  }, []);

  useEffect(() => {
    if (!errors.length || !focusSummaryRef.current) return;
    focusSummaryRef.current = false;
    summaryRef.current?.focus();
  }, [errors]);

  function focusField(event: React.MouseEvent<HTMLAnchorElement>, fieldId: string) {
    event.preventDefault();
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLElement)) return;
    field.focus();
    field.scrollIntoView({ block: "center", behavior: "auto" });
  }

  return (
    <div
      aria-labelledby={errors.length ? "submission-validation-heading" : undefined}
      className={errors.length ? "validation-summary" : undefined}
      ref={summaryRef}
      role={errors.length ? "alert" : undefined}
      tabIndex={errors.length ? -1 : undefined}
    >
      {errors.length ? (
        <>
          <h2 id="submission-validation-heading">Check the form</h2>
          <p>{errors.length === 1 ? "There is one field to check." : `There are ${errors.length} fields to check.`}</p>
          <ul>
            {errors.map((error) => (
              <li key={error.fieldId}>
                <a
                  href={`#${error.fieldId}`}
                  id={validationErrorId(error.fieldId)}
                  onClick={(event) => focusField(event, error.fieldId)}
                >
                  <strong>{error.label}:</strong> {error.message}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function asValidatableControl(target: EventTarget | null): ValidatableControl | undefined {
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return target;
  return undefined;
}

function validationErrorId(fieldId: string): string {
  return `validation-error-${fieldId}`;
}

function validationLabel(control: ValidatableControl): string {
  const explicit = control.getAttribute("aria-label")?.trim();
  if (explicit) return explicit;

  const label = control.labels?.[0];
  if (label) {
    const copy = label.cloneNode(true) as HTMLLabelElement;
    copy.querySelectorAll("input, select, textarea, .field-help").forEach((element) => element.remove());
    const text = copy.textContent?.replace(/\s+/gu, " ").replace(/\s*\(required\)\s*/iu, " ").trim();
    if (text) return text;
  }

  return control.name || control.id || "This field";
}

function validationMessage(control: ValidatableControl, label: string): string {
  const { validity } = control;
  if (validity.valueMissing) {
    return control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")
      ? `Select ${label}.`
      : `Enter ${label}.`;
  }
  if (validity.typeMismatch) return `Enter a valid ${label}.`;
  if (validity.tooShort && "minLength" in control) return `${label} must be at least ${control.minLength} characters.`;
  if (validity.tooLong && "maxLength" in control) return `${label} must be no more than ${control.maxLength} characters.`;
  if (validity.patternMismatch) return `Use the requested format for ${label}.`;
  if (validity.rangeUnderflow) return `${label} is below the allowed minimum.`;
  if (validity.rangeOverflow) return `${label} is above the allowed maximum.`;
  if (validity.stepMismatch || validity.badInput) return `Enter a valid value for ${label}.`;
  return `Check ${label}.`;
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
