/**
 * org-name.ts — write-boundary org-name validation (Wave-3B design item 1).
 *
 * assertOrgNameExists does a POINT GetItem on the NAME# reservation row and
 * rejects an absent row and a tombstoned row with DISTINCT messages. No
 * trim/normalize — exact match only (createOrganization stores names
 * verbatim; trimming here would let a stray-whitespace value validate
 * against a canonical name it doesn't byte-match).
 */

const mockSend = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return {
    ...actual,
    GetCommand: jest
      .fn()
      .mockImplementation((input) => ({ _type: "Get", input })),
  };
});

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  orgNameReservationKey,
  assertOrgNameExists,
  type NameReservationItem,
} from "../org-name";

const fakeDoc = {
  send: mockSend,
} as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("orgNameReservationKey", () => {
  test("builds the NAME# prefixed key verbatim, no trim", () => {
    expect(orgNameReservationKey("Acme")).toBe("NAME#Acme");
    expect(orgNameReservationKey(" Acme ")).toBe("NAME# Acme ");
  });
});

describe("assertOrgNameExists", () => {
  test("resolves for a live name_reservation row (point GetItem, not a Scan)", async () => {
    mockSend.mockResolvedValue({
      Item: {
        orgId: "NAME#Acme",
        itemType: "name_reservation",
        name: "Acme",
        createdAt: "2024-01-01T00:00:00Z",
      } satisfies NameReservationItem,
    });

    await expect(
      assertOrgNameExists(fakeDoc, "test-orgs", "Acme"),
    ).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0][0];
    expect(GetCommand).toHaveBeenCalledWith({
      TableName: "test-orgs",
      Key: { orgId: "NAME#Acme" },
    });
    expect(call._type).toBe("Get");
  });

  test("rejects when no NAME# row exists, with a not-found message", async () => {
    mockSend.mockResolvedValue({ Item: undefined });

    await expect(
      assertOrgNameExists(fakeDoc, "test-orgs", "Ghost"),
    ).rejects.toThrow(/does not exist/i);
  });

  test("rejects a name_tombstone row with a distinct reuse-specific message", async () => {
    mockSend.mockResolvedValue({
      Item: {
        orgId: "NAME#Deleted",
        itemType: "name_tombstone",
        name: "Deleted",
        createdAt: "2024-01-01T00:00:00Z",
        tombstonedAt: "2024-02-01T00:00:00Z",
      } satisfies NameReservationItem,
    });

    await expect(
      assertOrgNameExists(fakeDoc, "test-orgs", "Deleted"),
    ).rejects.toThrow(/deleted and cannot be reused/i);
  });

  test("absent-row and tombstone messages are textually distinct", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    let absentMessage = "";
    try {
      await assertOrgNameExists(fakeDoc, "test-orgs", "Ghost");
    } catch (err) {
      absentMessage = err instanceof Error ? err.message : "";
    }

    mockSend.mockResolvedValueOnce({
      Item: {
        orgId: "NAME#Deleted",
        itemType: "name_tombstone",
        name: "Deleted",
        createdAt: "2024-01-01T00:00:00Z",
      } satisfies NameReservationItem,
    });
    let tombstoneMessage = "";
    try {
      await assertOrgNameExists(fakeDoc, "test-orgs", "Deleted");
    } catch (err) {
      tombstoneMessage = err instanceof Error ? err.message : "";
    }

    expect(absentMessage).not.toBe("");
    expect(tombstoneMessage).not.toBe("");
    expect(absentMessage).not.toBe(tombstoneMessage);
  });

  test("is exact-match — a leading/trailing-whitespace variant is rejected when only the canonical name has a row (NO TRIM)", async () => {
    // The lookup key is built directly from the untrimmed input, so a
    // padded name resolves to a DIFFERENT NAME# key than the canonical
    // reservation row and misses — GetItem returns no Item.
    mockSend.mockResolvedValue({ Item: undefined });

    await expect(
      assertOrgNameExists(fakeDoc, "test-orgs", " Acme "),
    ).rejects.toThrow(/does not exist/i);

    expect(GetCommand).toHaveBeenCalledWith({
      TableName: "test-orgs",
      Key: { orgId: "NAME# Acme " },
    });
  });
});
