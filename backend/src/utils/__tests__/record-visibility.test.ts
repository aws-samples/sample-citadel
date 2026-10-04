/**
 * Property-based tests for record-visibility policy (decision fa3f8363).
 *
 * Uses fast-check to exhaustively probe the visibility matrix across all
 * combinations of persona (admin / architect / other), governed status,
 * org-match, and owner-match.
 */
import * as fc from "fast-check";
import {
  isRecordVisible,
  visibleStatusesFor,
  Viewer,
  VisibleRecord,
} from "../record-visibility";

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

const GOVERNED_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
] as const;

type GovernedStatus = (typeof GOVERNED_STATUSES)[number];

const statusArb: fc.Arbitrary<GovernedStatus> = fc.constantFrom(
  ...GOVERNED_STATUSES,
);

// ---------------------------------------------------------------------------
// Table-driven oracle — the authoritative matrix
// ---------------------------------------------------------------------------

interface MatrixCell {
  persona: "admin" | "architect" | "other";
  status: GovernedStatus | undefined; // undefined = legacy
  sameOrg: boolean;
  isOwner: boolean; // createdBy === viewer.userId
  createdByPresent: boolean; // whether record.createdBy is set
  expected: boolean;
}

function buildMatrix(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  const personas = ["admin", "architect", "other"] as const;
  const statuses: (GovernedStatus | undefined)[] = [
    undefined,
    ...GOVERNED_STATUSES,
  ];
  const bools = [true, false];

  for (const persona of personas) {
    for (const status of statuses) {
      for (const sameOrg of bools) {
        for (const isOwner of bools) {
          for (const createdByPresent of bools) {
            const expected = oracle(
              persona,
              status,
              sameOrg,
              isOwner,
              createdByPresent,
            );
            cells.push({
              persona,
              status,
              sameOrg,
              isOwner,
              createdByPresent,
              expected,
            });
          }
        }
      }
    }
  }

  return cells;
}

function oracle(
  persona: "admin" | "architect" | "other",
  status: GovernedStatus | undefined,
  sameOrg: boolean,
  isOwner: boolean,
  createdByPresent: boolean,
): boolean {
  if (persona === "admin") return true;
  if (status === undefined) return true; // legacy
  if (status === "APPROVED") return true;
  if (persona !== "architect") return false;
  // architect below
  if (status === "PENDING_APPROVAL") return sameOrg;
  if (status === "DRAFT") {
    if (createdByPresent) return isOwner;
    return sameOrg; // fallback: no createdBy → org proxy
  }
  // REJECTED, DEPRECATED
  return false;
}

// ---------------------------------------------------------------------------
// Helpers to materialise viewer/record from cell
// ---------------------------------------------------------------------------

const VIEWER_ORG = "org-A";
const OTHER_ORG = "org-B";
const VIEWER_USER = "user-1";
const OTHER_USER = "user-2";

function cellToViewer(cell: MatrixCell): Viewer {
  return {
    isAdmin: cell.persona === "admin",
    roles: cell.persona === "architect" ? ["architect"] : [],
    orgId: VIEWER_ORG,
    userId: VIEWER_USER,
  };
}

function cellToRecord(cell: MatrixCell): VisibleRecord {
  const rec: VisibleRecord = {};
  rec.status = cell.status;
  rec.orgId = cell.sameOrg ? VIEWER_ORG : OTHER_ORG;
  if (cell.createdByPresent) {
    rec.createdBy = cell.isOwner ? VIEWER_USER : OTHER_USER;
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("record-visibility policy (decision fa3f8363)", () => {
  // -----------------------------------------------------------------------
  // 1. Exhaustive table-driven oracle
  // -----------------------------------------------------------------------

  describe("exhaustive matrix", () => {
    const matrix = buildMatrix();

    test.each(matrix)(
      "$persona | status=$status | sameOrg=$sameOrg | isOwner=$isOwner | createdByPresent=$createdByPresent → $expected",
      (cell) => {
        const viewer = cellToViewer(cell);
        const record = cellToRecord(cell);
        expect(isRecordVisible(viewer, record)).toBe(cell.expected);
      },
    );
  });

  // -----------------------------------------------------------------------
  // 2. fast-check property: admin sees everything
  // -----------------------------------------------------------------------

  describe("property: admin sees everything", () => {
    test("admin always returns true regardless of status, org, or owner", () => {
      fc.assert(
        fc.property(
          statusArb,
          fc.constantFrom(VIEWER_ORG, OTHER_ORG, ""),
          fc.constantFrom(VIEWER_USER, OTHER_USER, undefined),
          (status, orgId, createdBy) => {
            const viewer: Viewer = {
              isAdmin: true,
              roles: [],
              orgId: VIEWER_ORG,
              userId: VIEWER_USER,
            };
            const record: VisibleRecord = { status, orgId, createdBy };
            expect(isRecordVisible(viewer, record)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    test("admin sees legacy records (no status)", () => {
      const viewer: Viewer = {
        isAdmin: true,
        roles: [],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      expect(isRecordVisible(viewer, {})).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. fast-check property: non-architect non-admin never sees non-APPROVED
  //    governed records
  // -----------------------------------------------------------------------

  describe("property: non-architect non-admin only sees APPROVED + legacy", () => {
    const nonApprovedGoverned = fc.constantFrom(
      "DRAFT",
      "PENDING_APPROVAL",
      "REJECTED",
      "DEPRECATED",
    ) as fc.Arbitrary<string>;

    test("non-APPROVED governed status is never visible", () => {
      fc.assert(
        fc.property(
          nonApprovedGoverned,
          fc.constantFrom(VIEWER_ORG, OTHER_ORG, ""),
          fc.constantFrom(VIEWER_USER, OTHER_USER, undefined),
          (status, orgId, createdBy) => {
            const viewer: Viewer = {
              isAdmin: false,
              roles: ["developer"],
              orgId: VIEWER_ORG,
              userId: VIEWER_USER,
            };
            const record: VisibleRecord = { status, orgId, createdBy };
            expect(isRecordVisible(viewer, record)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    test("APPROVED is always visible to everyone", () => {
      fc.assert(
        fc.property(fc.constantFrom(VIEWER_ORG, OTHER_ORG, ""), (orgId) => {
          const viewer: Viewer = {
            isAdmin: false,
            roles: [],
            orgId: VIEWER_ORG,
            userId: VIEWER_USER,
          };
          expect(isRecordVisible(viewer, { status: "APPROVED", orgId })).toBe(
            true,
          );
        }),
        { numRuns: 50 },
      );
    });

    test("legacy (no status) is always visible to everyone", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: [],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      expect(isRecordVisible(viewer, {})).toBe(true);
      expect(isRecordVisible(viewer, { orgId: OTHER_ORG })).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. fast-check property: architect never sees another org's
  //    DRAFT / PENDING_APPROVAL
  // -----------------------------------------------------------------------

  describe("property: architect cross-org DRAFT/PENDING invisible", () => {
    test("DRAFT from another org is invisible even to architect", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(VIEWER_USER, OTHER_USER, undefined),
          (createdBy) => {
            const viewer: Viewer = {
              isAdmin: false,
              roles: ["architect"],
              orgId: VIEWER_ORG,
              userId: VIEWER_USER,
            };
            // createdBy is someone from OTHER_ORG or absent — either way, not
            // the viewer (unless createdBy happens to equal VIEWER_USER, which
            // means owner-match kicks in).
            const record: VisibleRecord = {
              status: "DRAFT",
              orgId: OTHER_ORG,
              createdBy: createdBy === VIEWER_USER ? OTHER_USER : createdBy,
            };
            expect(isRecordVisible(viewer, record)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    test("PENDING_APPROVAL from another org is invisible to architect", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: ["architect"],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      const record: VisibleRecord = {
        status: "PENDING_APPROVAL",
        orgId: OTHER_ORG,
      };
      expect(isRecordVisible(viewer, record)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 5. fast-check property: system-shared records (orgId === "")
  // -----------------------------------------------------------------------

  describe("property: system-shared records visible to same-org architects", () => {
    test("PENDING_APPROVAL with empty orgId visible to any architect", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: ["architect"],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      expect(
        isRecordVisible(viewer, { status: "PENDING_APPROVAL", orgId: "" }),
      ).toBe(true);
    });

    test("DRAFT with empty orgId + no createdBy visible to architect (org fallback)", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: ["architect"],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      // orgId "" → orgMatch returns true → ownerMatch fallback → orgMatch → true
      expect(isRecordVisible(viewer, { status: "DRAFT", orgId: "" })).toBe(
        true,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6. visibleStatusesFor helper
  // -----------------------------------------------------------------------

  describe("visibleStatusesFor", () => {
    test("admin sees all governed statuses", () => {
      const viewer: Viewer = {
        isAdmin: true,
        roles: [],
        orgId: null,
        userId: null,
      };
      const result = visibleStatusesFor(viewer);
      expect(result).toEqual(expect.arrayContaining([...GOVERNED_STATUSES]));
      expect(result).toHaveLength(GOVERNED_STATUSES.length);
    });

    test("architect sees APPROVED, PENDING_APPROVAL, DRAFT", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: ["architect"],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      expect(visibleStatusesFor(viewer).sort()).toEqual(
        ["APPROVED", "DRAFT", "PENDING_APPROVAL"].sort(),
      );
    });

    test("developer sees only APPROVED", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: ["developer"],
        orgId: VIEWER_ORG,
        userId: VIEWER_USER,
      };
      expect(visibleStatusesFor(viewer)).toEqual(["APPROVED"]);
    });

    test("no roles sees only APPROVED", () => {
      const viewer: Viewer = {
        isAdmin: false,
        roles: [],
        orgId: null,
        userId: null,
      };
      expect(visibleStatusesFor(viewer)).toEqual(["APPROVED"]);
    });
  });
});
