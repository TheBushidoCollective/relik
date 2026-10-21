#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif

#if NAPI_VERSION < 8
#error "secure_open requires Node-API version 8 or newer"
#endif

#include <node_api.h>

#include "platform.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PATH_MAX
#error "secure_open requires PATH_MAX on supported targets"
#endif

#define RELIC_MAX_SAFE_INTEGER 9007199254740991ULL

struct relic_root_handle {
  int fd;
  bool closed;
};

struct relic_file_handle {
  int fd;
  off_t size;
  bool closed;
};

static const napi_type_tag relic_root_handle_tag = {
  0x8aa70d1f53e94f11ULL,
  0x8868ccdb92f448b3ULL,
};

static const napi_type_tag relic_file_handle_tag = {
  0x1e541d5a85f14818ULL,
  0xae26c5d85c2f4e4aULL,
};

enum relic_read_result {
  RELIC_READ_OK = 0,
  RELIC_READ_CHANGED = 1,
  RELIC_READ_ERROR = 2,
};

static napi_value relic_file_read(napi_env env, napi_callback_info info);
static napi_value relic_file_close(napi_env env, napi_callback_info info);
static napi_value relic_root_open_regular(napi_env env, napi_callback_info info);
static napi_value relic_root_close(napi_env env, napi_callback_info info);

static napi_value relic_throw_error(napi_env env, const char *code, const char *message) {
  napi_value message_value;
  napi_value code_value;
  napi_value error;

  if (
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
    napi_create_error(env, code_value, message_value, &error) != napi_ok
  ) {
    napi_throw_error(env, NULL, message);
    return NULL;
  }

  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
  return NULL;
}

static const char *relic_errno_code(int error_number) {
  switch (error_number) {
    case EACCES:
      return "EACCES";
    case EAGAIN:
      return "EAGAIN";
    case EBADF:
      return "EBADF";
    case EBUSY:
      return "EBUSY";
    case EEXIST:
      return "EEXIST";
    case EFBIG:
      return "EFBIG";
    case EINTR:
      return "EINTR";
    case EINVAL:
      return "EINVAL";
    case EIO:
      return "EIO";
    case EISDIR:
      return "EISDIR";
    case ELOOP:
      return "ELOOP";
    case EMFILE:
      return "EMFILE";
    case ENAMETOOLONG:
      return "ENAMETOOLONG";
    case ENFILE:
      return "ENFILE";
    case ENOENT:
      return "ENOENT";
    case ENOMEM:
      return "ENOMEM";
    case ENOSPC:
      return "ENOSPC";
    case ENOTDIR:
      return "ENOTDIR";
    case EPERM:
      return "EPERM";
    case EROFS:
      return "EROFS";
    case ESPIPE:
      return "ESPIPE";
    case EXDEV:
      return "EXDEV";
#ifdef ENOTCAPABLE
    case ENOTCAPABLE:
      return "ENOTCAPABLE";
#endif
    default:
      return "ERR_RELIC_NATIVE_OPEN_FAILED";
  }
}

static napi_value relic_throw_errno(
  napi_env env,
  int error_number,
  const char *syscall_name
) {
  char message[512];
  napi_value message_value;
  napi_value code_value;
  napi_value error;
  napi_value errno_value;
  napi_value syscall_value;
  const char *code = relic_errno_code(error_number);

  snprintf(
    message,
    sizeof(message),
    "%s failed: %s",
    syscall_name,
    strerror(error_number)
  );

  if (
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
    napi_create_error(env, code_value, message_value, &error) != napi_ok
  ) {
    napi_throw_error(env, NULL, message);
    return NULL;
  }

  napi_create_int32(env, error_number, &errno_value);
  napi_create_string_utf8(env, syscall_name, NAPI_AUTO_LENGTH, &syscall_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_set_named_property(env, error, "errno", errno_value);
  napi_set_named_property(env, error, "syscall", syscall_value);
  napi_throw(env, error);
  return NULL;
}

static napi_value relic_throw_platform_error(
  napi_env env,
  const struct relic_open_error *error
) {
  if (error->reason == RELIC_OPEN_REASON_PRIMITIVE_UNAVAILABLE) {
    char message[512];
    snprintf(
      message,
      sizeof(message),
      "native secure-open primitive is unavailable (%s: %s)",
      error->syscall_name,
      strerror(error->errno_value)
    );
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_PRIMITIVE_UNAVAILABLE",
      message
    );
  }

  return relic_throw_errno(env, error->errno_value, error->syscall_name);
}

static int relic_is_high_surrogate(char16_t value) {
  return value >= 0xd800 && value <= 0xdbff;
}

static int relic_is_low_surrogate(char16_t value) {
  return value >= 0xdc00 && value <= 0xdfff;
}

static char *relic_copy_path_argument(
  napi_env env,
  napi_value value,
  size_t *length_out
) {
  napi_valuetype type;
  size_t utf16_length = 0;
  size_t copied_utf16 = 0;
  char16_t *utf16 = NULL;
  size_t utf8_length = 0;
  size_t copied_utf8 = 0;
  char *utf8 = NULL;
  size_t index = 0;

  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "native secure-open paths must be strings"
    );
    return NULL;
  }

  if (
    napi_get_value_string_utf16(env, value, NULL, 0, &utf16_length) != napi_ok ||
    utf16_length == SIZE_MAX
  ) {
    relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "native secure-open could not read the path"
    );
    return NULL;
  }

  utf16 = calloc(utf16_length + 1, sizeof(*utf16));
  if (utf16 == NULL) {
    relic_throw_error(env, "ENOMEM", "native secure-open could not allocate the path");
    return NULL;
  }

  if (
    napi_get_value_string_utf16(
      env,
      value,
      utf16,
      utf16_length + 1,
      &copied_utf16
    ) != napi_ok ||
    copied_utf16 != utf16_length
  ) {
    free(utf16);
    relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "native secure-open could not read the path"
    );
    return NULL;
  }

  while (index < utf16_length) {
    if (utf16[index] == 0) {
      free(utf16);
      relic_throw_error(
        env,
        "ERR_RELIC_NATIVE_INVALID_PATH",
        "native secure-open paths cannot contain NUL"
      );
      return NULL;
    }
    if (relic_is_high_surrogate(utf16[index])) {
      if (
        index + 1 >= utf16_length ||
        !relic_is_low_surrogate(utf16[index + 1])
      ) {
        free(utf16);
        relic_throw_error(
          env,
          "ERR_RELIC_NATIVE_INVALID_PATH",
          "native secure-open paths cannot contain malformed UTF-16"
        );
        return NULL;
      }
      index += 2;
      continue;
    }
    if (relic_is_low_surrogate(utf16[index])) {
      free(utf16);
      relic_throw_error(
        env,
        "ERR_RELIC_NATIVE_INVALID_PATH",
        "native secure-open paths cannot contain malformed UTF-16"
      );
      return NULL;
    }
    index += 1;
  }
  free(utf16);

  if (
    napi_get_value_string_utf8(env, value, NULL, 0, &utf8_length) != napi_ok ||
    utf8_length == SIZE_MAX
  ) {
    relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "native secure-open could not read the path"
    );
    return NULL;
  }

  utf8 = malloc(utf8_length + 1);
  if (utf8 == NULL) {
    relic_throw_error(env, "ENOMEM", "native secure-open could not allocate the path");
    return NULL;
  }

  if (
    napi_get_value_string_utf8(
      env,
      value,
      utf8,
      utf8_length + 1,
      &copied_utf8
    ) != napi_ok ||
    copied_utf8 != utf8_length ||
    memchr(utf8, '\0', utf8_length) != NULL
  ) {
    free(utf8);
    relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "native secure-open could not read the path"
    );
    return NULL;
  }

  *length_out = utf8_length;
  return utf8;
}

static int relic_component_is_dot(const char *path, size_t length) {
  return length == 1 && path[0] == '.';
}

static int relic_component_is_dot_dot(const char *path, size_t length) {
  return length == 2 && path[0] == '.' && path[1] == '.';
}

static int relic_validate_path(
  const char *path,
  size_t length,
  bool absolute,
  bool reject_backslash
) {
  size_t index;

  if (length == 0 || length >= PATH_MAX) return 0;
  if (reject_backslash && memchr(path, '\\', length) != NULL) return 0;

  if (absolute) {
    if (path[0] != '/') return 0;
    if (length == 1) return 1;
    if (path[length - 1] == '/') return 0;
    index = 1;
  } else {
    if (path[0] == '/' || path[length - 1] == '/') return 0;
    index = 0;
  }

  while (index < length) {
    size_t component_start = index;
    while (index < length && path[index] != '/') index += 1;

    if (index == component_start) return 0;
    if (
      relic_component_is_dot(path + component_start, index - component_start) ||
      relic_component_is_dot_dot(path + component_start, index - component_start)
    ) {
      return 0;
    }

    if (index < length) index += 1;
  }

  return 1;
}

static int relic_safe_file_size(const struct stat *stat_value, off_t *size_out) {
  if (stat_value->st_size < 0) return 0;
  if ((uintmax_t)stat_value->st_size > RELIC_MAX_SAFE_INTEGER) return 0;
  *size_out = stat_value->st_size;
  return 1;
}

static void relic_root_finalize(napi_env env, void *data, void *hint) {
  struct relic_root_handle *root = data;
  (void)env;
  (void)hint;

  if (root != NULL) {
    if (!root->closed && root->fd >= 0) close(root->fd);
    free(root);
  }
}

static void relic_file_finalize(napi_env env, void *data, void *hint) {
  struct relic_file_handle *file = data;
  (void)env;
  (void)hint;

  if (file != NULL) {
    if (!file->closed && file->fd >= 0) close(file->fd);
    free(file);
  }
}

static struct relic_root_handle *relic_get_root(
  napi_env env,
  napi_value receiver
) {
  bool tag_matches = false;
  struct relic_root_handle *root = NULL;

  if (
    napi_check_object_type_tag(
      env,
      receiver,
      &relic_root_handle_tag,
      &tag_matches
    ) != napi_ok ||
    !tag_matches ||
    napi_unwrap(env, receiver, (void **)&root) != napi_ok ||
    root == NULL
  ) {
    relic_throw_error(env, "ERR_RELIC_NATIVE_INVALID_PATH", "invalid native bundle root handle");
    return NULL;
  }
  return root;
}

static struct relic_file_handle *relic_get_file(
  napi_env env,
  napi_value receiver
) {
  bool tag_matches = false;
  struct relic_file_handle *file = NULL;

  if (
    napi_check_object_type_tag(
      env,
      receiver,
      &relic_file_handle_tag,
      &tag_matches
    ) != napi_ok ||
    !tag_matches ||
    napi_unwrap(env, receiver, (void **)&file) != napi_ok ||
    file == NULL
  ) {
    relic_throw_error(env, "ERR_RELIC_NATIVE_INVALID_PATH", "invalid native file handle");
    return NULL;
  }
  return file;
}

static napi_value relic_make_file(napi_env env, int fd, off_t size) {
  struct relic_file_handle *file = NULL;
  napi_value object;
  napi_value size_value;
  napi_property_descriptor size_property;
  napi_property_descriptor methods[] = {
    {"read", NULL, relic_file_read, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, relic_file_close, NULL, NULL, NULL, napi_default, NULL},
  };

  file = calloc(1, sizeof(*file));
  if (file == NULL) {
    close(fd);
    return relic_throw_error(env, "ENOMEM", "native secure-open could not allocate a file handle");
  }
  file->fd = fd;
  file->size = size;
  file->closed = false;

  if (
    napi_create_object(env, &object) != napi_ok ||
    napi_create_double(env, (double)size, &size_value) != napi_ok
  ) {
    close(fd);
    free(file);
    return relic_throw_error(env, "ERR_RELIC_NATIVE_OPEN_FAILED", "native secure-open could not create a file handle");
  }

  size_property = (napi_property_descriptor){
    "size",
    NULL,
    NULL,
    NULL,
    NULL,
    size_value,
    napi_enumerable,
    NULL,
  };
  if (
    napi_define_properties(env, object, 1, &size_property) != napi_ok ||
    napi_define_properties(env, object, 2, methods) != napi_ok ||
    napi_type_tag_object(env, object, &relic_file_handle_tag) != napi_ok ||
    napi_wrap(env, object, file, relic_file_finalize, NULL, NULL) != napi_ok
  ) {
    close(fd);
    free(file);
    return relic_throw_error(env, "ERR_RELIC_NATIVE_OPEN_FAILED", "native secure-open could not create a file handle");
  }

  return object;
}

static napi_value relic_make_root(napi_env env, int fd) {
  struct relic_root_handle *root = NULL;
  napi_value object;
  napi_property_descriptor methods[] = {
    {"openRegular", NULL, relic_root_open_regular, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, relic_root_close, NULL, NULL, NULL, napi_default, NULL},
  };

  root = calloc(1, sizeof(*root));
  if (root == NULL) {
    close(fd);
    return relic_throw_error(env, "ENOMEM", "native secure-open could not allocate a root handle");
  }
  root->fd = fd;
  root->closed = false;

  if (
    napi_create_object(env, &object) != napi_ok ||
    napi_define_properties(env, object, 2, methods) != napi_ok ||
    napi_type_tag_object(env, object, &relic_root_handle_tag) != napi_ok ||
    napi_wrap(env, object, root, relic_root_finalize, NULL, NULL) != napi_ok
  ) {
    close(fd);
    free(root);
    return relic_throw_error(env, "ERR_RELIC_NATIVE_OPEN_FAILED", "native secure-open could not create a root handle");
  }

  return object;
}

static napi_value relic_open_bundle_root(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arguments[1];
  napi_value receiver;
  char *path = NULL;
  size_t path_length = 0;
  struct relic_open_error error = {0};
  struct stat stat_value = {0};
  int fd = -1;

  if (napi_get_cb_info(env, info, &argc, arguments, &receiver, NULL) != napi_ok || argc != 1) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "openBundleRoot requires exactly one absolute directory path"
    );
  }

  if (relic_probe_confined_open(&error) != 0) {
    return relic_throw_platform_error(env, &error);
  }

  path = relic_copy_path_argument(env, arguments[0], &path_length);
  if (path == NULL) return NULL;
  if (!relic_validate_path(path, path_length, true, false)) {
    free(path);
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "bundle root must be an absolute, normalized POSIX directory path"
    );
  }

  fd = relic_open_root(path, &error);
  free(path);
  if (fd < 0) return relic_throw_platform_error(env, &error);

  if (fstat(fd, &stat_value) != 0) {
    const int fstat_error = errno;
    close(fd);
    return relic_throw_errno(env, fstat_error, "fstat bundle root");
  }
  if (!S_ISDIR(stat_value.st_mode)) {
    close(fd);
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "bundle root must be a directory and cannot be a symlink"
    );
  }

  return relic_make_root(env, fd);
}

static napi_value relic_root_open_regular(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arguments[1];
  napi_value receiver;
  struct relic_root_handle *root;
  char *relative_path = NULL;
  size_t relative_path_length = 0;
  struct relic_open_error error = {0};
  struct stat stat_value = {0};
  off_t size = 0;
  int fd = -1;

  if (napi_get_cb_info(env, info, &argc, arguments, &receiver, NULL) != napi_ok || argc != 1) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "openRegular requires exactly one relative path"
    );
  }

  root = relic_get_root(env, receiver);
  if (root == NULL) return NULL;
  if (root->closed || root->fd < 0) {
    return relic_throw_error(env, "ERR_RELIC_NATIVE_CLOSED", "bundle root is closed");
  }

  relative_path = relic_copy_path_argument(env, arguments[0], &relative_path_length);
  if (relative_path == NULL) return NULL;
  if (!relic_validate_path(relative_path, relative_path_length, false, true)) {
    free(relative_path);
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_INVALID_PATH",
      "descendant path must be a normalized, nonempty relative POSIX path"
    );
  }

  fd = relic_open_descendant(root->fd, relative_path, &error);
  free(relative_path);
  if (fd < 0) return relic_throw_platform_error(env, &error);

  if (fstat(fd, &stat_value) != 0) {
    const int fstat_error = errno;
    close(fd);
    return relic_throw_errno(env, fstat_error, "fstat confined descendant");
  }
  if (!S_ISREG(stat_value.st_mode)) {
    close(fd);
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_NOT_REGULAR",
      "confined descendant must be a regular file"
    );
  }
  if (!relic_safe_file_size(&stat_value, &size)) {
    close(fd);
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "confined descendant size is not representable by JavaScript"
    );
  }

  return relic_make_file(env, fd, size);
}

static napi_value relic_close_root_or_file(
  napi_env env,
  int *fd,
  bool *closed,
  const char *kind
) {
  napi_value undefined_value;
  int closing_fd;

  if (*closed || *fd < 0) {
    napi_get_undefined(env, &undefined_value);
    return undefined_value;
  }

  closing_fd = *fd;
  *fd = -1;
  *closed = true;
  if (close(closing_fd) != 0) {
    return relic_throw_errno(env, errno, kind);
  }

  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

static napi_value relic_root_close(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value receiver;
  struct relic_root_handle *root;

  if (napi_get_cb_info(env, info, &argc, NULL, &receiver, NULL) != napi_ok) {
    return relic_throw_error(env, "ERR_RELIC_NATIVE_CLOSED", "could not close bundle root");
  }
  root = relic_get_root(env, receiver);
  if (root == NULL) return NULL;

  return relic_close_root_or_file(env, &root->fd, &root->closed, "close bundle root");
}

static enum relic_read_result relic_read_exact(
  int fd,
  unsigned char *buffer,
  size_t length,
  int *error_number
) {
  size_t bytes_read = 0;

  while (bytes_read < length) {
    const size_t remaining = length - bytes_read;
    const size_t requested =
      remaining > (size_t)SSIZE_MAX ? (size_t)SSIZE_MAX : remaining;
    const ssize_t received = pread(
      fd,
      buffer + bytes_read,
      requested,
      (off_t)bytes_read
    );

    if (received > 0) {
      bytes_read += (size_t)received;
      continue;
    }
    if (received == 0) return RELIC_READ_CHANGED;
    if (errno == EINTR) continue;

    *error_number = errno;
    return RELIC_READ_ERROR;
  }

  return RELIC_READ_OK;
}

static enum relic_read_result relic_probe_growth(
  int fd,
  off_t size,
  int *error_number
) {
  unsigned char sentinel = 0;

  for (;;) {
    const ssize_t received = pread(fd, &sentinel, 1, size);
    if (received == 0) return RELIC_READ_OK;
    if (received > 0) return RELIC_READ_CHANGED;
    if (errno == EINTR) continue;

    *error_number = errno;
    return RELIC_READ_ERROR;
  }
}

static napi_value relic_file_read(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arguments[1];
  napi_value receiver;
  struct relic_file_handle *file;
  napi_valuetype argument_type;
  double maximum_as_double;
  uint64_t maximum;
  struct stat stat_before = {0};
  struct stat stat_after = {0};
  size_t length;
  void *buffer_data = NULL;
  napi_value buffer;
  enum relic_read_result read_result;
  int read_error = 0;

  if (napi_get_cb_info(env, info, &argc, arguments, &receiver, NULL) != napi_ok || argc != 1) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "read requires exactly one nonnegative safe-integer maxBytes value"
    );
  }

  file = relic_get_file(env, receiver);
  if (file == NULL) return NULL;
  if (file->closed || file->fd < 0) {
    return relic_throw_error(env, "ERR_RELIC_NATIVE_CLOSED", "confined file is closed");
  }

  if (
    napi_typeof(env, arguments[0], &argument_type) != napi_ok ||
    argument_type != napi_number ||
    napi_get_value_double(env, arguments[0], &maximum_as_double) != napi_ok ||
    !(maximum_as_double >= 0.0) ||
    maximum_as_double > (double)RELIC_MAX_SAFE_INTEGER
  ) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "read maxBytes must be a nonnegative safe integer"
    );
  }
  maximum = (uint64_t)maximum_as_double;
  if ((double)maximum != maximum_as_double) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "read maxBytes must be a nonnegative safe integer"
    );
  }

  if (fstat(file->fd, &stat_before) != 0) {
    return relic_throw_errno(env, errno, "fstat confined file before read");
  }
  if (!S_ISREG(stat_before.st_mode) || stat_before.st_size != file->size) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_FILE_CHANGED",
      "confined file changed after it was opened"
    );
  }
  if ((uintmax_t)file->size > maximum || (uintmax_t)file->size > SIZE_MAX) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "confined file exceeds the caller's read bound"
    );
  }

  length = (size_t)file->size;
  if (napi_create_buffer(env, length, &buffer_data, &buffer) != napi_ok) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_SIZE_LIMIT",
      "native secure-open could not allocate a bounded read buffer"
    );
  }

  read_result = relic_read_exact(file->fd, buffer_data, length, &read_error);
  if (read_result == RELIC_READ_ERROR) {
    return relic_throw_errno(env, read_error, "pread confined file");
  }
  if (read_result == RELIC_READ_CHANGED) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_FILE_CHANGED",
      "confined file changed while it was read"
    );
  }

  if (fstat(file->fd, &stat_after) != 0) {
    return relic_throw_errno(env, errno, "fstat confined file after read");
  }
  if (!S_ISREG(stat_after.st_mode) || stat_after.st_size != file->size) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_FILE_CHANGED",
      "confined file changed while it was read"
    );
  }

  read_result = relic_probe_growth(file->fd, file->size, &read_error);
  if (read_result == RELIC_READ_ERROR) {
    return relic_throw_errno(env, read_error, "pread confined file growth probe");
  }
  if (read_result == RELIC_READ_CHANGED) {
    return relic_throw_error(
      env,
      "ERR_RELIC_NATIVE_FILE_CHANGED",
      "confined file grew while it was read"
    );
  }

  return buffer;
}

static napi_value relic_file_close(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value receiver;
  struct relic_file_handle *file;

  if (napi_get_cb_info(env, info, &argc, NULL, &receiver, NULL) != napi_ok) {
    return relic_throw_error(env, "ERR_RELIC_NATIVE_CLOSED", "could not close confined file");
  }
  file = relic_get_file(env, receiver);
  if (file == NULL) return NULL;

  return relic_close_root_or_file(env, &file->fd, &file->closed, "close confined file");
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"openBundleRoot", NULL, relic_open_bundle_root, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_value abi_version;

  if (
    napi_define_properties(env, exports, 1, methods) != napi_ok ||
    napi_create_uint32(env, 1, &abi_version) != napi_ok ||
    napi_set_named_property(env, exports, "abiVersion", abi_version) != napi_ok
  ) {
    napi_throw_error(env, "ERR_RELIC_NATIVE_ABI_MISMATCH", "could not initialize native secure-open");
    return NULL;
  }

  return exports;
}
