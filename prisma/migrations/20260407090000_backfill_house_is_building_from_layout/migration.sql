-- Immeubles mal classés (rez-de-chaussée floor=0 dans le layout) : aligner isBuilding sur la réalité du layout
UPDATE "House"
SET "isBuilding" = true
WHERE "isBuilding" = false
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE("layout"::jsonb, '[]'::jsonb)) AS elem
    WHERE (elem->>'floor')::int = 0
  );
