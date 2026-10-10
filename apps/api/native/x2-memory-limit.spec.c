#include "x2-memory-limit.h"
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

struct memory_case {
    const char *name;
    uint64_t memory;
    long page;
    bool expected;
    bool check_readback;
    uint64_t readback;
};

static const struct memory_case cases[] = {
    {"p4096_page", UINT64_C(4096), 4096, true, false, 0},
    {"p4096_U_minus_P", UINT64_C(9223372036854767616), 4096, true, false, 0},
    {"p4096_U_equal_readback", UINT64_C(9223372036854771712), 4096, false, true, UINT64_C(9223372036854771712)},
    {"p4096_zero", 0, 4096, false, false, 0},
    {"p4096_INT64_MAX", INT64_MAX, 4096, false, false, 0},
    {"p4096_UINT64_MAX", UINT64_MAX, 4096, false, false, 0},
    {"p4096_unaligned", UINT64_C(4097), 4096, false, false, 0},
    {"p4096_U_minus_one", UINT64_C(9223372036854771711), 4096, false, false, 0},
    {"p4096_above_INT64_MAX", UINT64_C(9223372036854775808), 4096, false, false, 0},
    {"p65536_page", UINT64_C(65536), 65536, true, false, 0},
    {"p65536_U_minus_P", UINT64_C(9223372036854644736), 65536, true, false, 0},
    {"p65536_U_equal_readback", UINT64_C(9223372036854710272), 65536, false, true, UINT64_C(9223372036854710272)},
    {"p65536_zero", 0, 65536, false, false, 0},
    {"p65536_INT64_MAX", INT64_MAX, 65536, false, false, 0},
    {"p65536_UINT64_MAX", UINT64_MAX, 65536, false, false, 0},
    {"p65536_unaligned", UINT64_C(65537), 65536, false, false, 0},
    {"p65536_U_minus_one", UINT64_C(9223372036854710271), 65536, false, false, 0},
    {"p65536_above_INT64_MAX", UINT64_C(9223372036854775808), 65536, false, false, 0},
    {"page_zero", UINT64_C(4096), 0, false, false, 0},
    {"page_negative", UINT64_C(4096), -1, false, false, 0},
    {"page_LONG_MIN", UINT64_C(4096), LONG_MIN, false, false, 0},
};

int main(void) {
    size_t failures = 0;
    const size_t count = sizeof(cases) / sizeof(cases[0]);
    for (size_t i = 0; i < count; ++i) {
        const struct memory_case *c = &cases[i];
        const bool actual = x2_memory_limit_valid(c->memory, c->page);
        const bool readback_matches = !c->check_readback || c->readback == c->memory;
        const bool passed = actual == c->expected && readback_matches;
        if (!passed) ++failures;
        printf("%s %s P=%ld M=%" PRIu64 " expected=%s actual=%s",
            passed ? "PASS" : "FAIL", c->name, c->page, c->memory,
            c->expected ? "accept" : "reject", actual ? "accept" : "reject");
        if (c->check_readback)
            printf(" synthetic_readback=%" PRIu64 " equal=%s", c->readback,
                readback_matches ? "true" : "false");
        putchar('\n');
    }
    printf("arithmetic-only: total=%zu passed=%zu failed=%zu\n",
        count, count - failures, failures);
    if (ferror(stdout)) {
        fputs("Failed to write arithmetic test results\n", stderr);
        return EXIT_FAILURE;
    }
    return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
