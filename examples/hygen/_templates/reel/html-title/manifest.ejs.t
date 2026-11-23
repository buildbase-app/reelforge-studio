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
      "id": "hook",
      "engine": "html",
      "template": "html-title",
      "durationSeconds": <%- sceneSeconds %>,
      "props": <%- j({ kicker, headline, subline, accent }) %>
    }<% if (cta) { %>,
    {
      "id": "cta",
      "engine": "html",
      "template": "html-title",
      "durationSeconds": <%- sceneSeconds %>,
      "props": <%- j({ kicker: ctaKicker, headline: cta, subline: ctaSubline, accent }) %>
    }<% } %>
  ]
}
