import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

import { getFlatSideBarLinks, getSidebar, isActive } from './sidebar'

/**
 * Compute previous/next navigation targets for the current page.
 * Falls back to sidebar-based navigation; respects frontmatter overrides.
 */
export function usePrevNext() {
  const { page, theme, frontmatter } = useData()

  return computed(() => {
    const hidePrev
      = (theme.value.docFooter?.prev === false && !frontmatter.value.prev)
        || frontmatter.value.prev === false

    const hideNext
      = (theme.value.docFooter?.next === false && !frontmatter.value.next)
        || frontmatter.value.next === false

    const sidebar = getSidebar(theme.value.sidebar, page.value.relativePath)
    const links = getFlatSideBarLinks(sidebar)

    // ignore inner-page links with hashes
    let candidates = uniqBy(links, link => link.link.replace(/[?#].*$/, ''))

    // Restrict docs navigation within the same docs section (e.g., overview vs manual)
    let normalizedPath = page.value.relativePath
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.slice(1)
    }
    const currentFullUrl = withBase(`/${normalizedPath}`)
    const sectionPrefix = getDocsSectionPrefix(currentFullUrl)
    if (sectionPrefix) {
      const sectionBase = withBase(sectionPrefix)
      const isSectionRoot = currentFullUrl.replace(/[?#].*$/, '') === sectionBase
      if (isSectionRoot) {
        return {
          prev: undefined,
          next: undefined,
        } as { prev?: { text?: string, link?: string }, next?: { text?: string, link?: string } }
      }
      const filtered = candidates
        .filter(l => l.link.replace(/[?#].*$/, '').startsWith(sectionBase))
        .filter(l => l.link.replace(/[?#].*$/, '') !== sectionBase)
      const wouldDropCurrent = filtered.findIndex(l => isActive(currentFullUrl, l.link)) < 0
      if (!wouldDropCurrent) {
        candidates = filtered
      }
    }

    const index = candidates.findIndex((link) => {
      let path = page.value.relativePath
      if (path.startsWith('/')) {
        path = path.slice(1)
      }

      return isActive(withBase(`/${path}`), link.link)
    })

    return {
      prev: hidePrev || index <= 0
        ? undefined
        : {
            text:
              (typeof frontmatter.value.prev === 'string'
                ? frontmatter.value.prev
                : typeof frontmatter.value.prev === 'object'
                  ? frontmatter.value.prev.text
                  : undefined)
                ?? candidates[index - 1]?.docFooterText
                ?? candidates[index - 1]?.text,
            link:
              (typeof frontmatter.value.prev === 'object'
                ? frontmatter.value.prev.link
                : undefined) ?? candidates[index - 1]?.link,
          },
      next: hideNext || index < 0 || index >= candidates.length - 1
        ? undefined
        : {
            text:
              (typeof frontmatter.value.next === 'string'
                ? frontmatter.value.next
                : typeof frontmatter.value.next === 'object'
                  ? frontmatter.value.next.text
                  : undefined)
                ?? candidates[index + 1]?.docFooterText
                ?? candidates[index + 1]?.text,
            link:
              (typeof frontmatter.value.next === 'object'
                ? frontmatter.value.next.link
                : undefined) ?? candidates[index + 1]?.link,
          },
    } as {
      prev?: { text?: string, link?: string }
      next?: { text?: string, link?: string }
    }
  })
}

/**
 * Extract docs section prefix like `/<lang>/docs/<section>/` from a full URL.
 */
function getDocsSectionPrefix(fullUrl: string): string | undefined {
  const m = fullUrl.match(/\/(en|zh-Hans)\/docs\/([^/]+)\//)
  return m ? `/${m[1]}/docs/${m[2]}/` : undefined
}

/**
 * Returns a unique array by key function result.
 */
function uniqBy<T>(array: T[], keyFn: (item: T) => any): T[] {
  const seen = new Set()
  return array.filter((item) => {
    const k = keyFn(item)
    return seen.has(k) ? false : seen.add(k)
  })
}
