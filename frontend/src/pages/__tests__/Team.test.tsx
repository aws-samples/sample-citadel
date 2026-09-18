/**
 * TDD cases for the Change Organization confirm dialog (task b4b41017, ITEM 3).
 *
 * Covers: the AlertDialog opens naming the user (email) + target org + a
 * sign-out warning, confirming calls assignUserRole, and cancelling does not.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <p>{children}</p>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <h3>{children}</h3>,
}));
jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: any) => <span data-testid="badge" className={className}>{children}</span>,
}));
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: any) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));
jest.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));
jest.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));
jest.mock("@/components/ui/accordion", () => ({
  Accordion: ({ children }: any) => <div>{children}</div>,
  AccordionItem: ({ children }: any) => <div>{children}</div>,
  AccordionTrigger: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AccordionContent: ({ children }: any) => <div>{children}</div>,
}));
jest.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: any) => (
    <div data-testid="org-select" onClick={() => onValueChange && onValueChange("Acme")}>{children}</div>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: any) => <button>{children}</button>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: any) => <p>{children}</p>,
  AlertDialogAction: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
jest.mock("@/components/PageContainer", () => ({
  PageContainer: ({ children }: any) => <div>{children}</div>,
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockUsers = [
  {
    userId: "u1",
    email: "admin@example.com",
    name: "Admin User",
    givenName: "Admin",
    familyName: "User",
    role: "admin",
    organization: "Default",
    status: "CONFIRMED",
    createdAt: "2025-01-01",
    enabled: true,
  },
  {
    userId: "u2",
    email: "dev@example.com",
    name: "Dev User",
    givenName: "Dev",
    familyName: "User",
    role: "developer",
    organization: "Default",
    status: "CONFIRMED",
    createdAt: "2025-01-02",
    enabled: true,
  },
];

const mockOrgs = [
  { orgId: "org-1", name: "Default", description: "Default organization", createdAt: "2025-01-01" },
  { orgId: "org-2", name: "Acme", description: "Acme organization", createdAt: "2025-01-01" },
];

jest.mock("@/services/userManagementService", () => ({
  userManagementService: {
    listUsers: jest.fn().mockResolvedValue(mockUsers),
    listAvailableRoles: jest.fn().mockResolvedValue(["admin", "developer", "viewer"]),
    listOrganizations: jest.fn().mockResolvedValue(mockOrgs),
    adminCreateUser: jest.fn().mockResolvedValue({ success: true, message: "ok" }),
    assignUserRole: jest.fn().mockResolvedValue({ success: true }),
    createOrganization: jest.fn().mockResolvedValue({ name: "NewOrg" }),
  },
}));

jest.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganization: "Default",
    currentUser: { userId: "u1", username: "admin@example.com", role: "admin" },
    isAdmin: true,
  }),
}));

import { Team } from "../Team";

async function openChangeOrgDialogFor(userName: string) {
  const userNode = screen.getByText(userName);
  let el: HTMLElement | null = userNode;
  let expandButton: HTMLButtonElement | null = null;
  while (el && !expandButton) {
    expandButton = el.querySelector("button.ml-4");
    el = el.parentElement;
  }
  expect(expandButton).toBeTruthy();
  fireEvent.click(expandButton as HTMLButtonElement);

  await waitFor(() => {
    expect(screen.getAllByText("Change Organization").length).toBeGreaterThan(0);
  });
  fireEvent.click(screen.getAllByText("Change Organization")[0]);

  await waitFor(() => {
    expect(screen.getAllByTestId("org-select").length).toBeGreaterThan(0);
  });
  fireEvent.click(screen.getAllByTestId("org-select")[0]);
}

function getSubmitChangeOrgButton(): HTMLButtonElement {
  const buttons = screen.getAllByRole("button", { name: /change organization/i });
  const submit = buttons.find((b) => b.className.includes("bg-primary")) as HTMLButtonElement;
  expect(submit).toBeTruthy();
  return submit;
}

describe("Team page — Change Organization confirm dialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { userManagementService } = require("@/services/userManagementService");
    userManagementService.listUsers.mockResolvedValue(mockUsers);
    userManagementService.listAvailableRoles.mockResolvedValue(["admin", "developer", "viewer"]);
    userManagementService.listOrganizations.mockResolvedValue(mockOrgs);
    userManagementService.assignUserRole.mockResolvedValue({ success: true });
  });

  test("selecting a new org and clicking Change Organization opens a confirm dialog naming the user, target org, and sign-out", async () => {
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText("Admin User")).toBeInTheDocument();
    });

    await openChangeOrgDialogFor("Admin User");

    fireEvent.click(getSubmitChangeOrgButton());

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    });

    const dialog = screen.getByTestId("alert-dialog");
    expect(dialog.textContent).toMatch(/admin@example\.com/i);
    expect(dialog.textContent).toMatch(/Acme/);
    expect(dialog.textContent).toMatch(/signed out of all sessions/i);
  });

  test("confirming calls assignUserRole with the target user id, role, and new organization", async () => {
    const { userManagementService } = require("@/services/userManagementService");
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText("Admin User")).toBeInTheDocument();
    });

    await openChangeOrgDialogFor("Admin User");
    fireEvent.click(getSubmitChangeOrgButton());

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    });

    const dialog = screen.getByTestId("alert-dialog");
    const confirmButton = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /change organization/i.test(b.textContent || ""),
    )!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(userManagementService.assignUserRole).toHaveBeenCalledWith({
        userId: "u1",
        role: "admin",
        organization: "Acme",
      });
    });
  });

  test("cancelling does not call assignUserRole", async () => {
    const { userManagementService } = require("@/services/userManagementService");
    render(<Team />);

    await waitFor(() => {
      expect(screen.getByText("Admin User")).toBeInTheDocument();
    });

    await openChangeOrgDialogFor("Admin User");
    fireEvent.click(getSubmitChangeOrgButton());

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    });

    const dialog = screen.getByTestId("alert-dialog");
    const cancelButton = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /cancel/i.test(b.textContent || ""),
    )!;
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });
    expect(userManagementService.assignUserRole).not.toHaveBeenCalled();
  });
});
