# Panduan Agen

## Alur kerja
- Pahami struktur, alur terkait, kontrak, dokumentasi, dan tes sebelum merancang perubahan; petakan komponen serta dependensi sebelum perubahan arsitektur.
- Skill lengkap tersedia di `docs/agent-skills/`. Baca salinan yang relevan dan, bila tersedia, panggil skill terpasang yang sesuai. Skill berlaku berdasarkan pemicunya; jangan menganggap semuanya berjalan otomatis.
- Ikuti alur Superpowers yang sesuai: mulai dengan `using-superpowers`; gunakan `brainstorming` untuk desain/perubahan kreatif; `writing-plans` untuk kebutuhan multi-langkah; TDD untuk fitur, perbaikan, dan perubahan perilaku; `subagent-driven-development` atau `executing-plans` untuk pelaksanaan; `systematic-debugging` saat terjadi kegagalan; skill review saat memberi atau menerima review; dan `verification-before-completion` sebelum menyatakan hasil.
- Jaga perubahan sekecil mungkin, pertahankan perilaku dan tes, jangan melemahkan atau menghapus tes, dan jangan menambah dependensi tanpa kebutuhan nyata.

## Keamanan dan kompatibilitas
- Pertahankan keselamatan backup/restore Chrome MV3 dan kontrak kompatibilitas rilis. Kontrak khusus rilis hanya boleh diubah berdasarkan desain atau spesifikasi yang telah disetujui.
- Jangan menghapus data browser/pengguna atau melakukan pembersihan storage yang luas.

## Git
- Jangan membuat commit, tag, atau push tanpa persetujuan eksplisit pengguna untuk tindakan tersebut. Jangan memakai amend, rebase, atau force-push sebagai pengganti persetujuan itu.
