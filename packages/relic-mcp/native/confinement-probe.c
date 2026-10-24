#if defined(__APPLE__) && defined(__MACH__)
#define _DARWIN_C_SOURCE
#elif defined(__linux__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#else
#error "Unsupported platform for confinement-probe"
#endif

#include "platform.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char inside_bytes[] = "inside-sentinel";
static const char outside_bytes[] = "outside-sentinel";

static int append_path(char *output, size_t output_size, const char *base, const char *name) {
  const int written = snprintf(output, output_size, "%s/%s", base, name);
  return written > 0 && (size_t)written < output_size ? 0 : -1;
}

static int write_file(const char *path, const char *bytes, size_t length) {
  const int file = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (file < 0) return -1;
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(file, bytes + offset, length - offset);
    if (written <= 0) {
      close(file);
      return -1;
    }
    offset += (size_t)written;
  }
  return close(file);
}

static int read_expected(int file, const char *expected, size_t length) {
  char buffer[128];
  if (length >= sizeof(buffer)) return -1;
  size_t offset = 0;
  while (offset < length) {
    const ssize_t bytes_read = read(file, buffer + offset, sizeof(buffer) - 1 - offset);
    if (bytes_read <= 0) return -1;
    offset += (size_t)bytes_read;
  }
  buffer[offset] = '\0';
  return offset == length && memcmp(buffer, expected, length) == 0 ? 0 : -1;
}

static int expect_accessible(const char *label, const char *path, const char *expected) {
  const int file = open(path, O_RDONLY | O_CLOEXEC);
  const int result = file < 0 ? -1 : read_expected(file, expected, strlen(expected));
  const int read_error = result == 0 ? 0 : (file < 0 ? errno : EIO);

  if (file >= 0) close(file);
  if (result != 0) {
    fprintf(
      stderr,
      "confinement-probe: accessible check failed for %s (%s): errno=%d\n",
      label,
      path,
      read_error
    );
    return -1;
  }
  printf("confinement-probe: accessible %s\n", label);
  return 0;
}

enum refusal_class {
  REFUSAL_ESCAPE,
  REFUSAL_SYMLINK,
  REFUSAL_NOT_DIRECTORY,
};

static int accepted_refusal_errno(
  enum refusal_class refusal_class,
  int error_number
) {
  switch (refusal_class) {
    case REFUSAL_ESCAPE:
#if defined(__APPLE__) && defined(__MACH__)
      if (error_number == EACCES) return 1;
#ifdef ENOTCAPABLE
      if (error_number == ENOTCAPABLE) return 1;
#endif
      return 0;
#elif defined(__linux__)
      return error_number == EXDEV;
#else
      return 0;
#endif
    case REFUSAL_SYMLINK:
      return error_number == ELOOP;
    case REFUSAL_NOT_DIRECTORY:
      return error_number == ENOTDIR;
  }
  return 0;
}

static const char *refusal_class_name(enum refusal_class refusal_class) {
  switch (refusal_class) {
    case REFUSAL_ESCAPE:
      return "escape";
    case REFUSAL_SYMLINK:
      return "symlink";
    case REFUSAL_NOT_DIRECTORY:
      return "not-directory";
  }
  return "unknown";
}

static int expect_refusal(
  const char *label,
  int file,
  const struct relic_open_error *error,
  enum refusal_class refusal_class
) {
  if (file >= 0) {
    close(file);
    printf("confinement-probe: FAIL %s: unexpectedly opened\n", label);
    return 1;
  }
  if (error->errno_value == 0) {
    printf("confinement-probe: FAIL %s: failed without errno\n", label);
    return 1;
  }
  if (!accepted_refusal_errno(refusal_class, error->errno_value)) {
    printf(
      "confinement-probe: FAIL %s: expected %s errno, got errno=%d syscall=%s\n",
      label,
      refusal_class_name(refusal_class),
      error->errno_value,
      error->syscall_name
    );
    return 1;
  }
  printf(
    "confinement-probe: refused %s errno=%d syscall=%s\n",
    label,
    error->errno_value,
    error->syscall_name
  );
  return 0;
}

static int expect_confined_bytes(int root_fd, const char *path, const char *expected) {
  struct relic_open_error error = {0};
  const int file = relic_open_descendant(root_fd, path, &error);
  const int result = file < 0 ? -1 : read_expected(file, expected, strlen(expected));
  const int read_error = result == 0 ? 0 : (file < 0 ? error.errno_value : errno);

  if (file >= 0) close(file);
  if (result != 0) {
    fprintf(
      stderr,
      "confinement-probe: confined read %s failed: errno=%d syscall=%s\n",
      path,
      read_error,
      file < 0 ? error.syscall_name : "read"
    );
    return -1;
  }
  printf("confinement-probe: confined read %s\n", path);
  return 0;
}

int main(void) {
#if defined(__APPLE__) && defined(__MACH__)
  char base_template[] = "/private/tmp/relic-confinement.XXXXXX";
#elif defined(__linux__)
  char base_template[] = "/tmp/relic-confinement.XXXXXX";
#endif
  char root[PATH_MAX] = {0};
  char moved_root[PATH_MAX] = {0};
  char root_link[PATH_MAX] = {0};
  char root_link_nested[PATH_MAX] = {0};
  char outside[PATH_MAX] = {0};
  char nested[PATH_MAX] = {0};
  char nested_inside[PATH_MAX] = {0};
  char nested_leaf_link[PATH_MAX] = {0};
  char middle_link[PATH_MAX] = {0};
  char root_link_inside[PATH_MAX] = {0};
  char middle_link_outside[PATH_MAX] = {0};
  char moved_nested[PATH_MAX] = {0};
  char moved_nested_original[PATH_MAX] = {0};
  char moved_nested_original_inside[PATH_MAX] = {0};
  char moved_nested_original_leaf_link[PATH_MAX] = {0};
  char moved_middle_link[PATH_MAX] = {0};
  char replaced_nested_outside[PATH_MAX] = {0};
  char *base = NULL;
  struct relic_open_error error = {0};
  int root_fd = -1;
  int failed_cases = 0;
  int status = 1;

  if (relic_probe_confined_open(&error) != 0) {
    fprintf(
      stderr,
      "confinement-probe: production primitive probe failed: errno=%d syscall=%s\n",
      error.errno_value,
      error.syscall_name
    );
    return 1;
  }
  printf("confinement-probe: production primitive probe passed\n");

  base = mkdtemp(base_template);
  if (base == NULL ||
      append_path(root, sizeof(root), base, "root") != 0 ||
      append_path(moved_root, sizeof(moved_root), base, "root-held") != 0 ||
      append_path(root_link, sizeof(root_link), base, "root-link") != 0 ||
      append_path(root_link_nested, sizeof(root_link_nested), root_link, "nested") != 0 ||
      append_path(outside, sizeof(outside), base, "outside.txt") != 0 ||
      append_path(nested, sizeof(nested), root, "nested") != 0 ||
      append_path(nested_inside, sizeof(nested_inside), nested, "inside.txt") != 0 ||
      append_path(nested_leaf_link, sizeof(nested_leaf_link), nested, "leaf-link") != 0 ||
      append_path(middle_link, sizeof(middle_link), root, "middle-link") != 0 ||
      append_path(root_link_inside, sizeof(root_link_inside), root_link, "nested/inside.txt") != 0 ||
      append_path(middle_link_outside, sizeof(middle_link_outside), middle_link, "outside.txt") != 0 ||
      append_path(moved_nested, sizeof(moved_nested), moved_root, "nested") != 0 ||
      append_path(moved_nested_original, sizeof(moved_nested_original), moved_root, "nested-original") != 0 ||
      append_path(
        moved_nested_original_inside,
        sizeof(moved_nested_original_inside),
        moved_nested_original,
        "inside.txt"
      ) != 0 ||
      append_path(
        moved_nested_original_leaf_link,
        sizeof(moved_nested_original_leaf_link),
        moved_nested_original,
        "leaf-link"
      ) != 0 ||
      append_path(moved_middle_link, sizeof(moved_middle_link), moved_root, "middle-link") != 0 ||
      append_path(replaced_nested_outside, sizeof(replaced_nested_outside), moved_nested, "outside.txt") != 0) {
    fprintf(stderr, "confinement-probe: could not prepare controlled paths\n");
    goto cleanup;
  }

  if (mkdir(root, 0700) != 0 ||
      mkdir(nested, 0700) != 0 ||
      write_file(nested_inside, inside_bytes, strlen(inside_bytes)) != 0 ||
      write_file(outside, outside_bytes, strlen(outside_bytes)) != 0 ||
      symlink(root, root_link) != 0 ||
      symlink(outside, nested_leaf_link) != 0 ||
      symlink(base, middle_link) != 0) {
    fprintf(stderr, "confinement-probe: could not prepare controlled topology: errno=%d\n", errno);
    goto cleanup;
  }

  if (expect_accessible("outside sentinel", outside, outside_bytes) != 0 ||
      expect_accessible("root symlink target", root_link_inside, inside_bytes) != 0 ||
      expect_accessible("leaf symlink target", nested_leaf_link, outside_bytes) != 0 ||
      expect_accessible("intermediate symlink target", middle_link_outside, outside_bytes) != 0) {
    goto cleanup;
  }

  root_fd = relic_open_root(root, &error);
  if (root_fd < 0 || expect_confined_bytes(root_fd, "nested/inside.txt", inside_bytes) != 0) {
    fprintf(
      stderr,
      "confinement-probe: known inside read failed: errno=%d syscall=%s\n",
      root_fd < 0 ? error.errno_value : 0,
      root_fd < 0 ? error.syscall_name : "openat"
    );
    goto cleanup;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "parent escape",
      relic_open_descendant(root_fd, "../outside.txt", &error),
      &error,
      REFUSAL_ESCAPE
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "absolute escape",
      relic_open_descendant(root_fd, outside, &error),
      &error,
      REFUSAL_ESCAPE
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "root symlink",
      relic_open_root(root_link, &error),
      &error,
      REFUSAL_SYMLINK
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "root ancestor symlink",
      relic_open_root(root_link_nested, &error),
      &error,
      REFUSAL_SYMLINK
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "root non-directory",
      relic_open_root(nested_inside, &error),
      &error,
      REFUSAL_NOT_DIRECTORY
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "leaf symlink",
      relic_open_descendant(root_fd, "nested/leaf-link", &error),
      &error,
      REFUSAL_SYMLINK
    ) != 0
  ) {
    failed_cases++;
  }

  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "intermediate symlink",
      relic_open_descendant(root_fd, "middle-link/outside.txt", &error),
      &error,
      REFUSAL_SYMLINK
    ) != 0
  ) {
    failed_cases++;
  }

#if defined(__linux__)
  {
    pid_t pid = getpid();
    char proc_pid_cwd[PATH_MAX] = {0};
    char proc_pid[PATH_MAX] = {0};
    snprintf(proc_pid_cwd, sizeof(proc_pid_cwd), "/proc/%ld/cwd", (long)pid);
    snprintf(proc_pid, sizeof(proc_pid), "/proc/%ld", (long)pid);

    int control_fd = open(proc_pid_cwd, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (control_fd < 0) {
      fprintf(
        stderr,
        "confinement-probe: positive control open %s failed: errno=%d\n",
        proc_pid_cwd,
        errno
      );
      goto cleanup;
    }
    close(control_fd);

    error = (struct relic_open_error){0};
    if (
      expect_refusal(
        "root magic link",
        relic_open_root(proc_pid_cwd, &error),
        &error,
        REFUSAL_SYMLINK
      ) != 0
    ) {
      failed_cases++;
    }

    error = (struct relic_open_error){0};
    int proc_root_fd = relic_open_root(proc_pid, &error);
    if (proc_root_fd < 0) {
      printf(
        "confinement-probe: FAIL descendant magic link: expected symlink errno, got errno=%d syscall=%s\n",
        error.errno_value,
        error.syscall_name
      );
      failed_cases++;
    } else {
      error = (struct relic_open_error){0};
      if (
        expect_refusal(
          "descendant magic link",
          relic_open_descendant(proc_root_fd, "cwd", &error),
          &error,
          REFUSAL_SYMLINK
        ) != 0
      ) {
        failed_cases++;
      }
      close(proc_root_fd);
    }
  }
#endif

  if (rename(root, moved_root) != 0 || mkdir(root, 0700) != 0) {
    fprintf(stderr, "confinement-probe: could not replace root pathname: errno=%d\n", errno);
    goto cleanup;
  }
  if (expect_confined_bytes(root_fd, "nested/inside.txt", inside_bytes) != 0) {
    printf("confinement-probe: FAIL held root: lost original bytes after rename\n");
    failed_cases++;
  } else {
    printf("confinement-probe: held root descriptor preserved original bytes after rename\n");
  }

  if (rename(moved_nested, moved_nested_original) != 0 || symlink(base, moved_nested) != 0) {
    fprintf(stderr, "confinement-probe: could not replace descendant directory: errno=%d\n", errno);
    goto cleanup;
  }
  if (expect_accessible("replaced descendant target", replaced_nested_outside, outside_bytes) != 0) {
    goto cleanup;
  }
  error = (struct relic_open_error){0};
  if (
    expect_refusal(
      "replaced descendant symlink",
      relic_open_descendant(root_fd, "nested/outside.txt", &error),
      &error,
      REFUSAL_SYMLINK
    ) != 0
  ) {
    failed_cases++;
  }

  if (failed_cases == 0) {
    status = 0;
    printf("confinement-probe: PASS\n");
  } else {
    status = 1;
    printf("confinement-probe: FAIL %d case(s)\n", failed_cases);
  }

cleanup:
  if (root_fd >= 0) close(root_fd);
  if (moved_nested[0] != '\0') unlink(moved_nested);
  if (moved_nested_original_leaf_link[0] != '\0') unlink(moved_nested_original_leaf_link);
  if (moved_nested_original_inside[0] != '\0') unlink(moved_nested_original_inside);
  if (moved_nested_original[0] != '\0') rmdir(moved_nested_original);
  if (moved_middle_link[0] != '\0') unlink(moved_middle_link);
  if (moved_root[0] != '\0') rmdir(moved_root);
  if (nested_leaf_link[0] != '\0') unlink(nested_leaf_link);
  if (nested_inside[0] != '\0') unlink(nested_inside);
  if (nested[0] != '\0') rmdir(nested);
  if (middle_link[0] != '\0') unlink(middle_link);
  if (root[0] != '\0') rmdir(root);
  if (root_link[0] != '\0') unlink(root_link);
  if (outside[0] != '\0') unlink(outside);
  if (base != NULL) rmdir(base);
  return status;
}
