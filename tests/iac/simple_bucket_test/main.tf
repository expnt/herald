resource "aws_s3_bucket" "example" {
  bucket = "swift-test"
}

resource "aws_s3_object" "object" {
  bucket = "swift-test"
  key    = "new_object_key"
  source = "sample.txt"

  # The filemd5() function is available in Terraform 0.11.12 and later
  # For Terraform 0.11.11 and earlier, use the md5() function and the file() function:
  # etag = "${md5(file("path/to/file"))}"
  etag       = filemd5("sample.txt")
  depends_on = [aws_s3_bucket.example]
}

# tofu apply
# tofu destroy
