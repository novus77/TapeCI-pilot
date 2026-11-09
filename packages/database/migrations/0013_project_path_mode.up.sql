-- Versioned (default) keeps every release under /releases/<id>/..., which is
-- immutable but incompatible with sites that load files at runtime or rely on
-- relative paths across pages. 'root' publishes files at their own paths.
ALTER TABLE projects
  ADD COLUMN path_mode text NOT NULL DEFAULT 'versioned'
  CHECK (path_mode IN ('versioned', 'root'));
