/**
 * Tests for the bucket-tagging backfill in resync-datastore-roles.ts.
 *
 * Uses a stateful fake S3 client that tracks per-bucket tag sets,
 * verifying: untagged → tagged on --apply only, conflict skipped,
 * merge preserves foreign tags, dry-run writes nothing.
 */
import {
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  Tag,
} from "@aws-sdk/client-s3";
import { reconcileBucketTags } from "../resync-datastore-roles";

// ---------------------------------------------------------------------------
// Stateful fake S3 client
// ---------------------------------------------------------------------------

interface FakeBucketState {
  tags: Tag[] | "NoSuchTagSet";
}

function createFakeS3(initial: Record<string, FakeBucketState>) {
  const state = new Map(Object.entries(initial));

  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof GetBucketTaggingCommand) {
      const bucket = command.input.Bucket!;
      const entry = state.get(bucket);
      if (!entry || entry.tags === "NoSuchTagSet") {
        const err = new Error("NoSuchTagSet") as Error & { name: string };
        err.name = "NoSuchTagSet";
        throw err;
      }
      return { TagSet: [...entry.tags] };
    }

    if (command instanceof PutBucketTaggingCommand) {
      const bucket = command.input.Bucket!;
      const tagSet = command.input.Tagging?.TagSet ?? [];
      state.set(bucket, { tags: [...tagSet] });
      return {};
    }

    throw new Error(
      `Unexpected command: ${(command as object).constructor.name}`,
    );
  };

  return {
    send,
    getState: () => state,
  };
}

// ---------------------------------------------------------------------------
// reconcileBucketTags
// ---------------------------------------------------------------------------

describe("reconcileBucketTags", () => {
  const DS_ID = "ds-001";
  const ORG_ID = "org-acme";
  const BUCKET = "citadel-test-bucket";

  describe("untagged bucket", () => {
    it("dry-run: reports 'tagged' but writes nothing", async () => {
      const s3 = createFakeS3({
        [BUCKET]: { tags: "NoSuchTagSet" },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        false,
      );

      expect(result.action).toBe("tagged");
      // Still untagged in state
      const entry = s3.getState().get(BUCKET)!;
      expect(entry.tags).toBe("NoSuchTagSet");
    });

    it("apply: tags the bucket with Citadel ownership tags", async () => {
      const s3 = createFakeS3({
        [BUCKET]: { tags: "NoSuchTagSet" },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("tagged");
      const entry = s3.getState().get(BUCKET)!;
      expect(entry.tags).not.toBe("NoSuchTagSet");
      const tags = entry.tags as Tag[];
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "ManagedBy", Value: "citadel" },
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: ORG_ID },
        ]),
      );
    });
  });

  describe("bucket with existing foreign tags", () => {
    it("apply: merges Citadel tags and preserves foreign tags", async () => {
      const s3 = createFakeS3({
        [BUCKET]: {
          tags: [
            { Key: "Environment", Value: "production" },
            { Key: "Team", Value: "platform" },
          ],
        },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("tagged");
      const tags = s3.getState().get(BUCKET)!.tags as Tag[];
      // Foreign tags preserved
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "Environment", Value: "production" },
          { Key: "Team", Value: "platform" },
        ]),
      );
      // Citadel tags added
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "ManagedBy", Value: "citadel" },
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: ORG_ID },
        ]),
      );
    });

    it("dry-run: does not modify tags even with foreign tags present", async () => {
      const original: Tag[] = [{ Key: "Environment", Value: "staging" }];
      const s3 = createFakeS3({
        [BUCKET]: { tags: [...original] },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        false,
      );

      expect(result.action).toBe("tagged");
      // Tags unchanged
      const tags = s3.getState().get(BUCKET)!.tags as Tag[];
      expect(tags).toEqual(original);
    });
  });

  describe("bucket already correctly tagged", () => {
    it("returns already_present and writes nothing", async () => {
      const s3 = createFakeS3({
        [BUCKET]: {
          tags: [
            { Key: "ManagedBy", Value: "citadel" },
            { Key: "citadel:dataStoreId", Value: DS_ID },
            { Key: "citadel:orgId", Value: ORG_ID },
          ],
        },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("already_present");
    });
  });

  describe("conflict: different dataStoreId", () => {
    it("returns conflict and does not overwrite", async () => {
      const original: Tag[] = [
        { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
        { Key: "citadel:orgId", Value: ORG_ID },
      ];
      const s3 = createFakeS3({
        [BUCKET]: { tags: [...original] },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("conflict");
      expect(result.reason).toContain("ds-OTHER");
      // Tags unchanged
      const tags = s3.getState().get(BUCKET)!.tags as Tag[];
      expect(tags).toEqual(original);
    });
  });

  describe("conflict: different orgId", () => {
    it("returns conflict and does not overwrite", async () => {
      const original: Tag[] = [
        { Key: "citadel:dataStoreId", Value: DS_ID },
        { Key: "citadel:orgId", Value: "org-DIFFERENT" },
      ];
      const s3 = createFakeS3({
        [BUCKET]: { tags: [...original] },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("conflict");
      expect(result.reason).toContain("org-DIFFERENT");
      // Tags unchanged
      const tags = s3.getState().get(BUCKET)!.tags as Tag[];
      expect(tags).toEqual(original);
    });
  });

  describe("partial tags: dataStoreId present, orgId missing", () => {
    it("apply: adds missing orgId tag, preserves existing dataStoreId", async () => {
      const s3 = createFakeS3({
        [BUCKET]: {
          tags: [
            { Key: "citadel:dataStoreId", Value: DS_ID },
            { Key: "SomeOther", Value: "keep-me" },
          ],
        },
      });

      const result = await reconcileBucketTags(
        s3 as never,
        BUCKET,
        DS_ID,
        ORG_ID,
        true,
      );

      expect(result.action).toBe("tagged");
      const tags = s3.getState().get(BUCKET)!.tags as Tag[];
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "SomeOther", Value: "keep-me" },
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: ORG_ID },
          { Key: "ManagedBy", Value: "citadel" },
        ]),
      );
    });
  });

  describe("idempotency", () => {
    it("calling twice on an untagged bucket produces the same final state", async () => {
      const s3 = createFakeS3({
        [BUCKET]: { tags: "NoSuchTagSet" },
      });

      await reconcileBucketTags(s3 as never, BUCKET, DS_ID, ORG_ID, true);
      const afterFirst = [...(s3.getState().get(BUCKET)!.tags as Tag[])];

      await reconcileBucketTags(s3 as never, BUCKET, DS_ID, ORG_ID, true);
      const afterSecond = s3.getState().get(BUCKET)!.tags as Tag[];

      // Second call should be already_present, tags unchanged
      expect(afterSecond).toEqual(afterFirst);
    });
  });
});
