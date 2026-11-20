# Vendored: directionality-indicator-webgl

Source: https://github.com/NeuroanatomyAndConnectivity/directionality-indicator-webgl

Revision: `2886087364fe4b68de516ab61cd71c3f580024f4`

Licence: LGPL-3.0-or-later (see `LICENSE`, `LICENSE.LESSER`, `NOTICE.md` in this folder).

Everything in this folder is upstream code. It is copied by
`tools/vendor_directionality.py`, which also applies five small patches
(data folder, panel host + programmatic `loadDataset`, no resize while hidden, test data paths,
no mipmap generation on the depth texture)
and generates `directionality.css` by scoping the upstream page styles to
`#ws-directionality`. Change upstream and re-run the script rather than
editing files here.
