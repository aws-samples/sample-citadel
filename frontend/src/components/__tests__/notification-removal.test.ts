/**
 * Unit tests: Notification system removal from AppHeader
 *
 * Verifies that the mock notification system has been completely removed
 * from AppHeader.tsx and the header layout is clean.
 *
 * Validates: Requirements 17.5, 17.6, 17.8
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_HEADER_PATH = path.resolve(__dirname, '..', 'AppHeader.tsx');
const source = fs.readFileSync(APP_HEADER_PATH, 'utf-8');

/**
 * Strip comments from source content.
 */
function stripComments(content: string): string {
  let stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  stripped = stripped.replace(/\/\/.*$/gm, '');
  return stripped;
}

const strippedSource = stripComments(source);

describe('Notification removal from AppHeader (Requirement 17.5, 17.6)', () => {
  // Validates: Requirement 17.7 — zero mockNotifications
  it('does NOT contain mockNotifications array', () => {
    expect(strippedSource).not.toContain('mockNotifications');
  });

  // Validates: Requirement 17.5 — bell icon removed
  it('does NOT import Bell from lucide-react', () => {
    expect(strippedSource).not.toMatch(/\bBell\b/);
  });

  // Validates: Requirement 17.5 — Activity icon removed (only used in notifications)
  it('does NOT import Activity from lucide-react', () => {
    expect(strippedSource).not.toMatch(/\bActivity\b/);
  });

  // Validates: Requirement 17.5 — notification dropdown removed
  it('does NOT contain notification dropdown markup', () => {
    expect(strippedSource).not.toContain('Notifications Dropdown');
    expect(strippedSource).not.toContain('Mark all as read');
    expect(strippedSource).not.toContain('showNotifications');
  });

  // Validates: Requirement 17.5 — notification badge removed
  it('does NOT contain notification badge', () => {
    expect(strippedSource).not.toContain('bg-red-500 rounded-full');
  });

  // Validates: Requirement 17.5 — notificationBtnRef removed
  it('does NOT contain notificationBtnRef', () => {
    expect(strippedSource).not.toContain('notificationBtnRef');
  });
});

describe('Header layout after notification removal (Requirement 17.6)', () => {
  // Validates: Requirement 17.6 — header layout adjusted cleanly
  it('still contains user profile button via DropdownMenu', () => {
    // shadcn DropdownMenu replaces manual showUserDropdown state
    expect(strippedSource).toContain('DropdownMenu');
    expect(strippedSource).toContain('DropdownMenuTrigger');
  });

  // Validates: Requirement 17.6 — right actions div exists with user profile button
  it('contains right actions div with flex layout', () => {
    expect(source).toContain('Right Actions');
    expect(strippedSource).toContain('flex items-center gap-2');
  });

  // Validates: Requirement 17.6 — search bar preserved
  it('still contains SearchInput component', () => {
    expect(strippedSource).toContain('SearchInput');
  });

  // Validates: Requirement 17.6 — user dropdown still has logout
  it('still contains logout option in dropdown', () => {
    expect(strippedSource).toContain('Logout');
  });

  // Validates: Requirement 17.6 — keyboard handling is now built into DropdownMenu
  it('uses DropdownMenu which provides built-in Escape key handling', () => {
    // shadcn DropdownMenu handles Escape internally via Radix
    expect(strippedSource).toContain('DropdownMenuContent');
  });

  // Validates: Requirement 17.6 — profile modals preserved
  it('still contains profile and password modals', () => {
    expect(strippedSource).toContain('showProfileModal');
    expect(strippedSource).toContain('showPasswordModal');
  });
});
