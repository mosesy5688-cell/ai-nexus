---
description: Standard feature deployment process with CES compliance check
---

1. Ensure all changes are implemented and verified.
2. Run CES Compliance Check:
// turbo
   ```powershell
   npm run ces-check
   ```
3. If CES fails, FIX issues and RE-RUN step 2.
4. If CES passes, commit changes:
   ```powershell
   git add .
   git commit -m "feat: [Feature Description]"
   ```
5. Push to feature branch:
   ```powershell
   git push -u origin feature/[branch-name]
   ```
6. Create Pull Request:
   ```powershell
   gh pr create --title "feat: [Feature Title]" --body "[Description]"
   ```
7. Merge Pull Request (once approved/ready):
   ```powershell
   gh pr merge --merge --auto --delete-branch
   ```
