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
    { "id": "hook", "engine": "remotion", "template": "kinetic-title", "durationSeconds": 2,
      "props": <%- j({ headline, subline, accent }) %> },
    { "id": "steps", "engine": "motion-canvas", "template": "animated-explainer", "durationSeconds": 3,
      "props": <%- j({ title: stepsTitle, points, accent }) %> },
    { "id": "card", "engine": "html", "template": "html-title", "durationSeconds": 2,
      "props": <%- j({ kicker, headline: card, accent }) %> },
    { "id": "outro", "engine": "hyperframes", "template": "hyperframes-title", "durationSeconds": 2,
      "props": <%- j({ headline: outro, subline: outroSubline, accent }) %> }
  ]
}
