---
to: <%= out %>
---
{
  "schemaVersion": "0.2",
  "projectId": <%- j(name) %>,
  "title": <%- j(title) %>,
  "output": { "width": 1080, "height": 1920, "fps": 30, "format": "mp4" },
  "theme": <%- j(theme) %>,
  "scenes": [
    {
      "id": "steps",
      "engine": "motion-canvas",
      "template": "animated-explainer",
      "durationSeconds": <%- sceneSeconds %>,
      "props": <%- j({ title: headline, points, accent }) %>
    }
  ]
}
