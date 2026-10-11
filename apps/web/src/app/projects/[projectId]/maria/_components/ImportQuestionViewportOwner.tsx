"use client";

import { useEffect, useRef, type ReactNode } from "react";

const NARROW_MOBILE_VIEWPORT_WIDTH = 640;
const GEOMETRY_EPSILON_PX = 1;

export function ImportQuestionViewportOwner({
  children,
}: {
  children: ReactNode;
}) {
  const owner = useRef<HTMLDivElement>(null);
  const bottomSpace = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ownerElement = owner.current;
    const bottomSpaceElement = bottomSpace.current;
    const viewport = window.visualViewport;
    if (!ownerElement || !bottomSpaceElement || !viewport) return;

    let pendingFrame: number | null = null;
    let lastBlockedGeometry: {
      form: HTMLFormElement;
      signature: string;
    } | null = null;
    let observedForm: HTMLFormElement | null = null;
    let formResizeObserver: ResizeObserver;

    const setBottomSpace = (height: number) => {
      const normalizedHeight = Math.max(0, Math.ceil(height));
      const nextHeight = `${normalizedHeight}px`;
      bottomSpaceElement.hidden = normalizedHeight === 0;
      if (bottomSpaceElement.style.height !== nextHeight)
        bottomSpaceElement.style.height = nextHeight;
    };

    const focusedForm = () => {
      const focused = document.activeElement;
      if (
        viewport.width >= NARROW_MOBILE_VIEWPORT_WIDTH ||
        !(focused instanceof HTMLElement) ||
        !ownerElement.contains(focused) ||
        !focused.matches("input, select, textarea, button")
      )
        return null;

      const form = focused.closest("form");
      return form instanceof HTMLFormElement && ownerElement.contains(form)
        ? form
        : null;
    };

    const syncObservedForm = () => {
      const form = focusedForm();
      if (form === observedForm) return form;
      if (observedForm) formResizeObserver.unobserve(observedForm);
      observedForm = form;
      if (observedForm) formResizeObserver.observe(observedForm);
      return form;
    };

    const keepFocusedActionsVisible = () => {
      pendingFrame = null;
      const form = syncObservedForm();
      const actions = form?.querySelector<HTMLElement>(
        "[data-import-question-actions]",
      );
      if (!form || !actions) {
        lastBlockedGeometry = null;
        setBottomSpace(0);
        return;
      }

      const viewportTop = viewport.offsetTop;
      const viewportBottom = viewportTop + viewport.height;
      setBottomSpace(window.innerHeight - viewportBottom);

      const actionRect = actions.getBoundingClientRect();
      const overflowBelow = actionRect.bottom - viewportBottom;
      const overflowAbove = viewportTop - actionRect.top;
      const correction =
        overflowBelow > GEOMETRY_EPSILON_PX
          ? overflowBelow
          : overflowAbove > GEOMETRY_EPSILON_PX
            ? -overflowAbove
            : 0;
      if (correction === 0) {
        lastBlockedGeometry = null;
        return;
      }

      const geometry = [
        viewportTop,
        viewportBottom,
        actionRect.top,
        actionRect.bottom,
        ownerElement.scrollTop,
      ].join(":");
      if (
        lastBlockedGeometry?.form === form &&
        lastBlockedGeometry.signature === geometry
      )
        return;
      lastBlockedGeometry = { form, signature: geometry };

      const maximumScroll = Math.max(
        0,
        ownerElement.scrollHeight - ownerElement.clientHeight,
      );
      const nextScroll = Math.min(
        maximumScroll,
        Math.max(0, ownerElement.scrollTop + correction),
      );
      if (Math.abs(nextScroll - ownerElement.scrollTop) > GEOMETRY_EPSILON_PX)
        ownerElement.scrollTop = nextScroll;
    };

    const scheduleVisibilityCheck = () => {
      if (pendingFrame !== null) return;
      pendingFrame = window.requestAnimationFrame(keepFocusedActionsVisible);
    };

    formResizeObserver = new ResizeObserver(scheduleVisibilityCheck);

    viewport.addEventListener("resize", scheduleVisibilityCheck);
    viewport.addEventListener("scroll", scheduleVisibilityCheck);
    document.addEventListener("focusin", scheduleVisibilityCheck);
    document.addEventListener("focusout", scheduleVisibilityCheck);

    return () => {
      viewport.removeEventListener("resize", scheduleVisibilityCheck);
      viewport.removeEventListener("scroll", scheduleVisibilityCheck);
      document.removeEventListener("focusin", scheduleVisibilityCheck);
      document.removeEventListener("focusout", scheduleVisibilityCheck);
      formResizeObserver.disconnect();
      if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    };
  }, []);

  return (
    <div
      ref={owner}
      data-import-question-viewport-owner="true"
      className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-y-contain px-1 py-3"
    >
      {children}
      <div
        ref={bottomSpace}
        aria-hidden="true"
        hidden
        className="pointer-events-none w-full shrink-0"
      />
    </div>
  );
}
