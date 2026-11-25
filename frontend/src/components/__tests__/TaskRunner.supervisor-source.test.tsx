/**
 * TaskRunner — supervisor chatter detection must match the REAL EventBridge
 * source string.
 *
 * chatter-publisher.ts forwards `event.source` verbatim into the AppSync
 * mutation's `source` field (backend/src/lambda/chatter-publisher.ts). The
 * supervisor always emits `SUPERVISOR_RESPONSE_SOURCE = 'citadel.supervisor'`
 * (arbiter/supervisor/index.py), regardless of what the caller's callback
 * config set — see arbiter/supervisor/__tests__/test_send_response_callback_hardening.py
 * ("Source: ALWAYS the reserved constant SUPERVISOR_RESPONSE_SOURCE
 * ('citadel.supervisor'), regardless of callback.source"). A chatter message
 * therefore never arrives with `source === 'supervisor'` — only
 * `source === 'citadel.supervisor'`.
 */

jest.mock("../../hooks/useChatterSubscription", () => ({
  __esModule: true,
  useChatterSubscription: jest.fn(),
}));

jest.mock("../../services/taskRunnerService", () => ({
  __esModule: true,
  taskRunnerService: { submitTask: jest.fn() },
}));

jest.mock("../../services/server", () => ({
  __esModule: true,
  default: { getConfig: () => null },
}));

import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from "@testing-library/react";
import { TaskRunner } from "../TaskRunner";
import { useChatterSubscription } from "../../hooks/useChatterSubscription";
import { taskRunnerService } from "../../services/taskRunnerService";
import type { ChatterMessage } from "../../services/chatterService";

// jsdom does not implement scrollIntoView; AgentChatter calls it on mount.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

const mockUseChatterSubscription =
  useChatterSubscription as jest.MockedFunction<typeof useChatterSubscription>;
const mockSubmitTask = taskRunnerService.submitTask as jest.MockedFunction<
  typeof taskRunnerService.submitTask
>;

describe("TaskRunner — supervisor response detection by real event source", () => {
  it("recognizes a chatter message whose source is the real EventBridge source 'citadel.supervisor'", async () => {
    let handleChatterMessage: (message: ChatterMessage) => void = () => {};

    mockUseChatterSubscription.mockImplementation((onMessage) => {
      handleChatterMessage = onMessage;
      return { current: null };
    });
    mockSubmitTask.mockResolvedValue({
      success: true,
      orchestrationId: "orch-1",
      message: "Task submitted successfully",
    });

    render(<TaskRunner />);

    const textarea = screen.getByPlaceholderText(/Describe what you want/i);
    fireEvent.change(textarea, { target: { value: "Do something" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Submit Task/i }));
    });

    act(() => {
      handleChatterMessage({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        source: "citadel.supervisor",
        detailType: "task.response",
        detail: { message: "Task completed successfully" },
      });
    });

    expect(screen.getByText("Task completed successfully")).toBeInTheDocument();
  });
});
